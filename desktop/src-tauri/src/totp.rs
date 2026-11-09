//! Authenticator codes (TOTP, RFC 6238). When an account's setup key is saved,
//! the vault shows the same six digits the phone app does.
//!
//! A setup key is accepted either bare (the base32 text sites show under "can't
//! scan the QR code?") or as the `otpauth://totp/...` link a QR code holds.

use std::time::{SystemTime, UNIX_EPOCH};

use hmac::{Hmac, Mac};
use serde::Serialize;
use sha1::Sha1;
use sha2::{Sha256, Sha512};
use zeroize::Zeroizing;

use crate::error::{VaultError, VaultResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Algorithm {
    Sha1,
    Sha256,
    Sha512,
}

pub struct Totp {
    key: Zeroizing<Vec<u8>>,
    algorithm: Algorithm,
    digits: u32,
    period: u64,
}

impl std::fmt::Debug for Totp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Totp")
            .field("key", &"<redacted>")
            .field("algorithm", &self.algorithm)
            .field("digits", &self.digits)
            .field("period", &self.period)
            .finish()
    }
}

/// The code to show now, and when it stops being valid.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TotpCode {
    pub code: String,
    pub period: u64,
    /// Unix time in milliseconds.
    pub expires_at: u64,
}

impl std::fmt::Debug for TotpCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TotpCode(<redacted>)")
    }
}

fn invalid(message: &str) -> VaultError {
    VaultError::invalid_input(message)
}

/// RFC 4648 base32, forgiving about case, spaces, dashes and padding.
fn base32_decode(input: &str) -> Option<Zeroizing<Vec<u8>>> {
    // Sized up front so it never reallocates (which would leave unwiped copies).
    let mut out = Zeroizing::new(Vec::with_capacity(input.len() * 5 / 8 + 1));
    let (mut buffer, mut bits) = (0u32, 0u32);
    for c in input.chars() {
        if c.is_whitespace() || c == '-' || c == '=' {
            continue;
        }
        let value = match c.to_ascii_uppercase() {
            upper @ 'A'..='Z' => upper as u32 - 'A' as u32,
            digit @ '2'..='7' => digit as u32 - '2' as u32 + 26,
            _ => return None,
        };
        buffer = (buffer << 5) | value;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// `%XX` escapes in a link's query value.
fn percent_decode(value: &str) -> Zeroizing<String> {
    let hex = |byte: u8| (byte as char).to_digit(16).map(|digit| digit as u8);
    let bytes = value.as_bytes();
    let mut out = Zeroizing::new(Vec::with_capacity(bytes.len()));
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2]))
        {
            out.push(high << 4 | low);
            index += 3;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    Zeroizing::new(String::from_utf8_lossy(&out).into_owned())
}

impl Totp {
    pub fn parse(input: &str) -> VaultResult<Self> {
        let input = input.trim();
        let mut algorithm = Algorithm::Sha1;
        let (mut digits, mut period) = (6u32, 30u64);
        let secret: Zeroizing<String>;

        let scheme = input.get(..10).map(str::to_ascii_lowercase);
        if scheme.as_deref() == Some("otpauth://") {
            let rest = &input[10..];
            if !rest
                .get(..5)
                .is_some_and(|kind| kind.eq_ignore_ascii_case("totp/"))
            {
                return Err(invalid(
                    "Only time-based authenticator codes are supported.",
                ));
            }
            let query = rest.split_once('?').map(|(_, query)| query).unwrap_or("");
            let mut found = None;
            for pair in query.split('&') {
                let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
                let value = percent_decode(value);
                match name.to_ascii_lowercase().as_str() {
                    "secret" => found = Some(value),
                    "algorithm" => {
                        algorithm = match value.to_ascii_uppercase().as_str() {
                            "SHA1" => Algorithm::Sha1,
                            "SHA256" => Algorithm::Sha256,
                            "SHA512" => Algorithm::Sha512,
                            _ => {
                                return Err(invalid(
                                    "That authenticator link uses an unknown algorithm.",
                                ));
                            }
                        }
                    }
                    "digits" => {
                        digits = value
                            .parse()
                            .ok()
                            .filter(|d| (6..=8).contains(d))
                            .ok_or_else(|| {
                                invalid("Authenticator codes must have 6 to 8 digits.")
                            })?
                    }
                    "period" => {
                        period = value
                            .parse()
                            .ok()
                            .filter(|p| (1..=600).contains(p))
                            .ok_or_else(|| {
                                invalid("That authenticator link has an invalid period.")
                            })?
                    }
                    _ => {}
                }
            }
            secret = found.ok_or_else(|| invalid("That authenticator link has no setup key."))?;
        } else {
            secret = Zeroizing::new(input.to_owned());
        }

        let key = base32_decode(&secret)
            .ok_or_else(|| invalid("A setup key only has the letters A–Z and the digits 2–7."))?;
        if key.len() < 5 {
            return Err(invalid("That setup key is too short."));
        }
        Ok(Self {
            key,
            algorithm,
            digits,
            period,
        })
    }

    fn mac(&self, message: &[u8]) -> Vec<u8> {
        // HMAC accepts keys of any length, so these never fail.
        match self.algorithm {
            Algorithm::Sha1 => {
                let mut mac = Hmac::<Sha1>::new_from_slice(&self.key).expect("any key length");
                mac.update(message);
                mac.finalize().into_bytes().to_vec()
            }
            Algorithm::Sha256 => {
                let mut mac = Hmac::<Sha256>::new_from_slice(&self.key).expect("any key length");
                mac.update(message);
                mac.finalize().into_bytes().to_vec()
            }
            Algorithm::Sha512 => {
                let mut mac = Hmac::<Sha512>::new_from_slice(&self.key).expect("any key length");
                mac.update(message);
                mac.finalize().into_bytes().to_vec()
            }
        }
    }

    /// The code for a Unix time in seconds (RFC 4226 dynamic truncation).
    pub fn code_at(&self, unix_seconds: u64) -> String {
        let digest = self.mac(&(unix_seconds / self.period).to_be_bytes());
        let offset = (digest[digest.len() - 1] & 0x0f) as usize;
        let binary = u32::from_be_bytes([
            digest[offset] & 0x7f,
            digest[offset + 1],
            digest[offset + 2],
            digest[offset + 3],
        ]);
        let code = binary % 10u32.pow(self.digits);
        format!("{code:0width$}", width = self.digits as usize)
    }

    pub fn now(&self) -> TotpCode {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        let seconds = now.as_secs();
        let window_end = (seconds / self.period + 1) * self.period;
        TotpCode {
            code: self.code_at(seconds),
            period: self.period,
            expires_at: window_end * 1000,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(key: &[u8], algorithm: Algorithm) -> Totp {
        Totp {
            key: Zeroizing::new(key.to_vec()),
            algorithm,
            digits: 8,
            period: 30,
        }
    }

    /// RFC 6238, appendix B.
    #[test]
    fn matches_the_rfc_6238_test_vectors() {
        let sha1 = raw(b"12345678901234567890", Algorithm::Sha1);
        let sha256 = raw(b"12345678901234567890123456789012", Algorithm::Sha256);
        let sha512 = raw(
            b"1234567890123456789012345678901234567890123456789012345678901234",
            Algorithm::Sha512,
        );
        for (time, one, two, five) in [
            (59, "94287082", "46119246", "90693936"),
            (1_111_111_109, "07081804", "68084774", "25091201"),
            (1_111_111_111, "14050471", "67062674", "99943326"),
            (1_234_567_890, "89005924", "91819424", "93441116"),
            (2_000_000_000, "69279037", "90698825", "38618901"),
            (20_000_000_000, "65353130", "77737706", "47863826"),
        ] {
            assert_eq!(sha1.code_at(time), one, "SHA1 at {time}");
            assert_eq!(sha256.code_at(time), two, "SHA256 at {time}");
            assert_eq!(sha512.code_at(time), five, "SHA512 at {time}");
        }
    }

    #[test]
    fn reads_bare_setup_keys_forgivingly() {
        assert_eq!(
            base32_decode("JBSWY3DPEHPK3PXP").unwrap().as_slice(),
            b"Hello!\xDE\xAD\xBE\xEF"
        );
        let spaced = Totp::parse("  jbsw y3dp-ehpk 3pxp  ").unwrap();
        assert_eq!(*spaced.key, b"Hello!\xDE\xAD\xBE\xEF");
        assert_eq!(
            (spaced.digits, spaced.period, spaced.algorithm),
            (6, 30, Algorithm::Sha1)
        );
        assert!(Totp::parse("not base32 1890").is_err());
        assert!(Totp::parse("").is_err());
    }

    #[test]
    fn reads_otpauth_links() {
        // "12345678901234567890" in base32.
        let link = "otpauth://totp/GitHub:me%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ\
                    &issuer=GitHub&algorithm=SHA1&digits=8&period=30";
        let totp = Totp::parse(link).unwrap();
        assert_eq!(totp.code_at(59), "94287082");

        let short = Totp::parse("OTPAUTH://TOTP/x?secret=JBSWY3DPEHPK3PXP").unwrap();
        assert_eq!((short.digits, short.period), (6, 30));
        assert_eq!(short.code_at(0).len(), 6);

        assert!(Totp::parse("otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1").is_err());
        assert!(Totp::parse("otpauth://totp/x?issuer=nobody").is_err());
        assert!(Totp::parse("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=4").is_err());
        assert!(Totp::parse("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=MD5").is_err());
    }

    #[test]
    fn the_current_code_expires_at_the_end_of_its_window() {
        let totp = Totp::parse("JBSWY3DPEHPK3PXP").unwrap();
        let code = totp.now();
        assert_eq!(code.code.len(), 6);
        assert_eq!(code.expires_at % 30_000, 0);
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        assert!(code.expires_at > now_ms - 1000 && code.expires_at <= now_ms + 30_000);
        assert!(!format!("{totp:?}{code:?}").contains("Hello"));
    }
}
