//! Length-prefixed JSON frames.
//!
//! Browser ↔ bridge is native messaging: a 32-bit length in the machine's byte order,
//! then UTF-8 JSON (the browser reads and writes it that way). Bridge ↔ app carries the
//! same frames with a little-endian length, so both ends agree on any machine.

use std::io;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// The largest frame either side accepts. Browsers allow far more; nothing VaultKey sends
/// comes close, and the cap keeps a bad peer from making us allocate.
pub const MAX_FRAME: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ByteOrder {
    /// Native messaging: browser ↔ bridge.
    Native,
    /// Bridge ↔ app.
    Little,
}

impl ByteOrder {
    fn decode(self, bytes: [u8; 4]) -> u32 {
        match self {
            ByteOrder::Native => u32::from_ne_bytes(bytes),
            ByteOrder::Little => u32::from_le_bytes(bytes),
        }
    }

    fn encode(self, length: u32) -> [u8; 4] {
        match self {
            ByteOrder::Native => length.to_ne_bytes(),
            ByteOrder::Little => length.to_le_bytes(),
        }
    }
}

fn invalid(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

/// Reads one frame. `Ok(None)` when the peer closed cleanly between two frames.
///
/// Not cancel-safe: a frame half read is lost if the future is dropped. Callers read
/// each stream from one task that owns it (see `host`).
pub async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R, order: ByteOrder) -> io::Result<Option<Vec<u8>>> {
    let mut header = [0u8; 4];
    let mut filled = 0;
    while filled < header.len() {
        let read = reader.read(&mut header[filled..]).await?;
        if read == 0 {
            return if filled == 0 {
                Ok(None)
            } else {
                Err(io::Error::new(io::ErrorKind::UnexpectedEof, "frame header cut short"))
            };
        }
        filled += read;
    }
    let length = order.decode(header) as usize;
    if length == 0 || length > MAX_FRAME {
        return Err(invalid(format!("frame of {length} bytes (1 to {MAX_FRAME} allowed)")));
    }
    let mut payload = vec![0; length];
    reader.read_exact(&mut payload).await?;
    Ok(Some(payload))
}

/// Writes one frame (header and body in one write) and flushes it.
pub async fn write_frame<W: AsyncWrite + Unpin>(writer: &mut W, order: ByteOrder, payload: &[u8]) -> io::Result<()> {
    if payload.is_empty() || payload.len() > MAX_FRAME {
        return Err(invalid(format!(
            "frame of {} bytes (1 to {MAX_FRAME} allowed)",
            payload.len()
        )));
    }
    let mut frame = Vec::with_capacity(4 + payload.len());
    // Fits: MAX_FRAME is far below u32::MAX.
    frame.extend_from_slice(&order.encode(payload.len() as u32));
    frame.extend_from_slice(payload);
    writer.write_all(&frame).await?;
    writer.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap().block_on(future)
    }

    #[test]
    fn frames_round_trip_in_both_byte_orders() {
        block_on(async {
            for order in [ByteOrder::Native, ByteOrder::Little] {
                let mut buffer = Vec::new();
                write_frame(&mut buffer, order, br#"{"t":"ping","n":1}"#).await.unwrap();
                write_frame(&mut buffer, order, b"{}").await.unwrap();
                let mut reader = buffer.as_slice();
                assert_eq!(
                    read_frame(&mut reader, order).await.unwrap().unwrap(),
                    br#"{"t":"ping","n":1}"#
                );
                assert_eq!(read_frame(&mut reader, order).await.unwrap().unwrap(), b"{}");
                assert!(read_frame(&mut reader, order).await.unwrap().is_none());
            }
        });
    }

    #[test]
    fn the_app_hop_is_little_endian() {
        block_on(async {
            let mut buffer = Vec::new();
            write_frame(&mut buffer, ByteOrder::Little, b"{}").await.unwrap();
            assert_eq!(buffer, [2, 0, 0, 0, b'{', b'}']);
        });
    }

    #[test]
    fn a_header_split_across_reads_is_put_back_together() {
        block_on(async {
            let (mut client, mut server) = tokio::io::duplex(64);
            let reader = tokio::spawn(async move { read_frame(&mut server, ByteOrder::Little).await });
            client.write_all(&[2, 0]).await.unwrap();
            client.flush().await.unwrap();
            tokio::task::yield_now().await;
            client.write_all(&[0, 0, b'{', b'}']).await.unwrap();
            let read = tokio::time::timeout(std::time::Duration::from_secs(5), reader).await;
            assert_eq!(read.expect("read within 5 s").unwrap().unwrap().unwrap(), b"{}");
        });
    }

    #[test]
    fn oversized_or_empty_frames_are_refused_both_ways() {
        block_on(async {
            let big = vec![b' '; MAX_FRAME + 1];
            assert_eq!(
                write_frame(&mut Vec::new(), ByteOrder::Little, &big).await.unwrap_err().kind(),
                io::ErrorKind::InvalidData
            );
            assert!(write_frame(&mut Vec::new(), ByteOrder::Little, b"").await.is_err());
            assert!(write_frame(&mut Vec::new(), ByteOrder::Little, &big[..MAX_FRAME]).await.is_ok());

            // A peer announcing more than the cap is cut off before anything is allocated.
            let header = ((MAX_FRAME + 1) as u32).to_le_bytes();
            let mut reader = header.as_slice();
            assert_eq!(
                read_frame(&mut reader, ByteOrder::Little).await.unwrap_err().kind(),
                io::ErrorKind::InvalidData
            );
            let mut zero = [0u8; 4].as_slice();
            assert!(read_frame(&mut zero, ByteOrder::Little).await.is_err());
        });
    }

    #[test]
    fn a_stream_cut_mid_frame_is_an_error_not_a_clean_close() {
        block_on(async {
            let mut header_only = [1u8, 0].as_slice();
            assert_eq!(
                read_frame(&mut header_only, ByteOrder::Little).await.unwrap_err().kind(),
                io::ErrorKind::UnexpectedEof
            );
            let mut body_cut = [5u8, 0, 0, 0, b'{'].as_slice();
            assert_eq!(
                read_frame(&mut body_cut, ByteOrder::Little).await.unwrap_err().kind(),
                io::ErrorKind::UnexpectedEof
            );
        });
    }
}
