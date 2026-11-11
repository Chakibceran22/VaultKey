//! The bridge: native messaging on stdio, relayed to the app.
//!
//! It answers `bridge.status` itself and passes every other frame through unread,
//! both ways. It holds nothing: pairing carries public keys only, and a session's frames
//! are encrypted end to end (Noise KK between the extension and the app).
//! It connects to the app when first needed, and again after the app went away. No
//! polling: it only acts on a frame.

use std::{borrow::Cow, future::Future, io};

use serde::Deserialize;
use tokio::{
    io::{AsyncRead, AsyncWrite, WriteHalf},
    sync::mpsc,
};

use crate::{
    address::Address,
    frame::{self, ByteOrder},
    message::{AppPresence, ErrorCode, Message},
};

#[cfg(unix)]
pub type AppStream = tokio::net::UnixStream;
#[cfg(windows)]
pub type AppStream = tokio::net::windows::named_pipe::NamedPipeClient;

/// Opens a connection to the app at `address`.
pub async fn connect(address: &Address) -> io::Result<AppStream> {
    match address {
        #[cfg(unix)]
        Address::Socket(path) => tokio::net::UnixStream::connect(path).await,
        #[cfg(windows)]
        Address::Pipe(name) => {
            use tokio::net::windows::named_pipe::ClientOptions;
            /// Between two clients the pipe is briefly busy (Win32 `ERROR_PIPE_BUSY`).
            const ERROR_PIPE_BUSY: i32 = 231;
            for _ in 0..20 {
                match ClientOptions::new().open(name) {
                    Ok(client) => {
                        // Only a VaultKey running as this user: someone else who created
                        // the name first gets nothing relayed.
                        if !crate::windows::server_is_current_user(&client)? {
                            return Err(io::Error::new(
                                io::ErrorKind::PermissionDenied,
                                "VaultKey's pipe is served by another user",
                            ));
                        }
                        return Ok(client);
                    }
                    Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    }
                    Err(error) => return Err(error),
                }
            }
            Err(io::Error::new(io::ErrorKind::TimedOut, "VaultKey's pipe stayed busy"))
        }
    }
}

enum Event {
    Browser(Vec<u8>),
    BrowserClosed,
    App { connection: u64, frame: Vec<u8> },
    AppClosed { connection: u64 },
}

enum Kind {
    BridgeStatus,
    ForApp,
    Refused,
}

/// Only the type is read here; the app checks the rest.
#[derive(Deserialize)]
struct Tag<'a> {
    #[serde(borrow)]
    t: Cow<'a, str>,
}

fn kind(frame: &[u8]) -> Kind {
    // Objects only (a struct would also read `["ping",7]`); every message is one.
    if frame.iter().find(|byte| !byte.is_ascii_whitespace()) != Some(&b'{') {
        return Kind::Refused;
    }
    match serde_json::from_slice::<Tag>(frame) {
        Ok(tag) if tag.t == "bridge.status" => match Message::from_bytes(frame) {
            Ok(Message::BridgeStatus {}) => Kind::BridgeStatus,
            _ => Kind::Refused,
        },
        // `bridge.*` is ours alone; `bridge.launch` arrives later.
        Ok(tag) if tag.t.starts_with("bridge.") => Kind::Refused,
        Ok(_) => Kind::ForApp,
        Err(_) => Kind::Refused,
    }
}

/// Reads frames from `stream` on its own task, so a frame is never cut in half by
/// something else happening (`read_frame` isn't cancel-safe).
fn spawn_reader<R>(
    mut stream: R,
    order: ByteOrder,
    events: mpsc::Sender<Event>,
    on_frame: impl Fn(Vec<u8>) -> Event + Send + 'static,
    on_close: Event,
) where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        while let Ok(Some(frame)) = frame::read_frame(&mut stream, order).await {
            if events.send(on_frame(frame)).await.is_err() {
                return;
            }
        }
        let _ = events.send(on_close).await;
    });
}

struct AppLink<S> {
    connection: u64,
    writer: WriteHalf<S>,
}

/// Runs the bridge until the browser closes `input`. `connect` opens a connection to the
/// app; it is called when one is needed and none is open.
pub async fn run<I, O, C, F, S>(input: I, mut output: O, connect: C) -> io::Result<()>
where
    I: AsyncRead + Unpin + Send + 'static,
    O: AsyncWrite + Unpin,
    C: Fn() -> F,
    F: Future<Output = io::Result<S>>,
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let (events, mut inbox) = mpsc::channel(32);
    spawn_reader(input, ByteOrder::Native, events.clone(), Event::Browser, Event::BrowserClosed);

    let mut app: Option<AppLink<S>> = None;
    let mut connections: u64 = 0;
    // One quiet reconnect per browser frame (see AppClosed), so an app that keeps closing
    // connections can't make the bridge loop.
    let mut may_reconnect = true;

    while let Some(event) = inbox.recv().await {
        match event {
            Event::BrowserClosed => break,
            Event::Browser(frame) => {
                may_reconnect = true;
                match kind(&frame) {
                    Kind::BridgeStatus => {
                        if app.is_none() {
                            app = open_app(&connect, &events, &mut connections).await;
                        }
                        reply(&mut output, presence(app.is_some())).await?;
                    }
                    Kind::ForApp => {
                        if app.is_none() {
                            app = open_app(&connect, &events, &mut connections).await;
                        }
                        // Retry only a connection that died, not one that never opened (the
                        // app isn't running: one failed connect is enough).
                        let had_link = app.is_some();
                        let mut sent = send_to_app(&mut app, &frame).await;
                        if !sent && had_link && std::mem::take(&mut may_reconnect) {
                            // The connection died under this frame (the app may have closed
                            // it after refusing the previous one, before we saw it close):
                            // one fresh connection, then the same frame again.
                            app = open_app(&connect, &events, &mut connections).await;
                            sent = send_to_app(&mut app, &frame).await;
                        }
                        if !sent {
                            // The frame is dropped: the extension sees the app is gone and asks again.
                            app = None;
                            reply(&mut output, presence(false)).await?;
                        }
                    }
                    Kind::Refused => reply(&mut output, Message::Err { code: ErrorCode::BadFrame, need: None }).await?,
                }
            }
            Event::App { connection, frame } => {
                if app.as_ref().is_some_and(|link| link.connection == connection) {
                    frame::write_frame(&mut output, ByteOrder::Native, &frame).await?;
                }
            }
            Event::AppClosed { connection } => {
                if app.as_ref().is_some_and(|link| link.connection == connection) {
                    // A closed connection doesn't mean the app quit: it also closes after
                    // refusing a frame. Look once; only report it gone if it is.
                    app = None;
                    if std::mem::take(&mut may_reconnect) {
                        app = open_app(&connect, &events, &mut connections).await;
                    }
                    if app.is_none() {
                        reply(&mut output, presence(false)).await?;
                    }
                }
            }
        }
    }
    Ok(())
}

async fn open_app<C, F, S>(connect: &C, events: &mpsc::Sender<Event>, connections: &mut u64) -> Option<AppLink<S>>
where
    C: Fn() -> F,
    F: Future<Output = io::Result<S>>,
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let stream = connect().await.ok()?;
    let (reader, writer) = tokio::io::split(stream);
    *connections += 1;
    let connection = *connections;
    spawn_reader(
        reader,
        ByteOrder::Little,
        events.clone(),
        move |frame| Event::App { connection, frame },
        Event::AppClosed { connection },
    );
    Some(AppLink { connection, writer })
}

/// Writes `frame` to the app; false if there's no connection or it has died.
async fn send_to_app<S: AsyncWrite>(app: &mut Option<AppLink<S>>, frame: &[u8]) -> bool {
    match app.as_mut() {
        Some(link) => frame::write_frame(&mut link.writer, ByteOrder::Little, frame).await.is_ok(),
        None => false,
    }
}

fn presence(running: bool) -> Message {
    Message::BridgeState {
        app: if running { AppPresence::Running } else { AppPresence::NotRunning },
    }
}

async fn reply<O: AsyncWrite + Unpin>(output: &mut O, message: Message) -> io::Result<()> {
    frame::write_frame(output, ByteOrder::Native, &message.to_bytes()).await
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
        time::Duration,
    };

    use tokio::io::{AsyncRead, DuplexStream};

    use super::*;

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
    }

    /// Connections handed out in order; none left means "VaultKey isn't running".
    fn connections(streams: Vec<DuplexStream>) -> impl Fn() -> std::future::Ready<io::Result<DuplexStream>> {
        let streams = Arc::new(Mutex::new(VecDeque::from(streams)));
        move || {
            let next = streams.lock().unwrap().pop_front();
            std::future::ready(next.ok_or_else(|| io::Error::from(io::ErrorKind::ConnectionRefused)))
        }
    }

    /// A connection whose app end is already gone: writes to it fail.
    fn dead() -> DuplexStream {
        tokio::io::duplex(1024).0
    }

    /// A connection to an app that answers each ping with a pong.
    fn answering() -> DuplexStream {
        let (bridge_end, app_end) = tokio::io::duplex(1024);
        tokio::spawn(async move {
            let (mut reader, mut writer) = tokio::io::split(app_end);
            while let Ok(Some(frame)) = frame::read_frame(&mut reader, ByteOrder::Little).await {
                if let Ok(Message::Ping { n }) = Message::from_bytes(&frame) {
                    let pong = Message::Pong { n }.to_bytes();
                    if frame::write_frame(&mut writer, ByteOrder::Little, &pong).await.is_err() {
                        return;
                    }
                }
            }
        });
        bridge_end
    }

    async fn next<R: AsyncRead + Unpin>(reader: &mut R) -> Message {
        let frame = tokio::time::timeout(Duration::from_secs(5), frame::read_frame(reader, ByteOrder::Native))
            .await
            .expect("the bridge answered within 5 s")
            .unwrap()
            .unwrap();
        Message::from_bytes(&frame).unwrap()
    }

    /// Runs the bridge on in-memory stdio; returns the browser's ends.
    fn start(streams: Vec<DuplexStream>) -> (DuplexStream, DuplexStream) {
        let (browser_in, bridge_in) = tokio::io::duplex(4096);
        let (bridge_out, browser_out) = tokio::io::duplex(4096);
        tokio::spawn(run(bridge_in, bridge_out, connections(streams)));
        (browser_in, browser_out)
    }

    #[test]
    fn a_frame_written_into_a_dead_connection_is_resent_on_a_fresh_one() {
        runtime().block_on(async {
            // The first connection is already closed when the frame is written (the app
            // closed it, and the bridge hasn't seen that yet); the second one is fine.
            let (mut to_bridge, mut from_bridge) = start(vec![dead(), answering()]);
            frame::write_frame(&mut to_bridge, ByteOrder::Native, br#"{"t":"ping","n":9}"#).await.unwrap();
            // The pong, and nothing claiming the app is gone (the dead connection's late
            // close is recognised as stale and ignored).
            assert_eq!(next(&mut from_bridge).await, Message::Pong { n: 9 });
            frame::write_frame(&mut to_bridge, ByteOrder::Native, br#"{"t":"ping","n":10}"#).await.unwrap();
            assert_eq!(next(&mut from_bridge).await, Message::Pong { n: 10 });
        });
    }

    #[test]
    fn says_not_running_when_the_fresh_connection_fails_too() {
        runtime().block_on(async {
            let (mut to_bridge, mut from_bridge) = start(vec![dead()]);
            frame::write_frame(&mut to_bridge, ByteOrder::Native, br#"{"t":"ping","n":1}"#).await.unwrap();
            assert_eq!(
                next(&mut from_bridge).await,
                Message::BridgeState { app: AppPresence::NotRunning }
            );
        });
    }
}
