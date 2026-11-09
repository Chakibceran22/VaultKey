//! The error contract shared with the frontend.
//!
//! Serialises to `{ "code": "INVALID_INPUT", "message": "..." }`, the same shape the
//! Electron main process returned, so the UI's error handling is unchanged.

use serde::Serialize;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InvalidInput,
    /// Part of the frontend contract; currently never produced (a wrong password is
    /// `{ valid: false }`, not an error), exactly as in the Electron app.
    #[allow(dead_code)]
    AuthFailed,
    VaultLocked,
    AlreadyExists,
    NotFound,
    DatabaseUnavailable,
    Internal,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidInput => "INVALID_INPUT",
            Self::AuthFailed => "AUTH_FAILED",
            Self::VaultLocked => "VAULT_LOCKED",
            Self::AlreadyExists => "ALREADY_EXISTS",
            Self::NotFound => "NOT_FOUND",
            Self::DatabaseUnavailable => "DATABASE_UNAVAILABLE",
            Self::Internal => "INTERNAL",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VaultError {
    pub code: ErrorCode,
    pub message: String,
    /// Diagnostic detail for logs only; never sent to the frontend.
    #[serde(skip)]
    pub detail: Option<String>,
}

pub type VaultResult<T> = Result<T, VaultError>;

pub const UNAVAILABLE_MESSAGE: &str = "The local vault is unavailable.";

impl VaultError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            detail: None,
        }
    }

    pub fn with_detail(mut self, detail: impl fmt::Display) -> Self {
        self.detail = Some(detail.to_string());
        self
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidInput, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }

    pub fn already_exists(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::AlreadyExists, message)
    }

    pub fn locked(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::VaultLocked, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }

    pub fn unavailable() -> Self {
        Self::new(ErrorCode::DatabaseUnavailable, UNAVAILABLE_MESSAGE)
    }
}

impl fmt::Display for VaultError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for VaultError {}

/// Mirrors `mapDatabaseError` from the Electron app, but keys off SQLite's extended
/// result codes instead of matching message text.
impl From<rusqlite::Error> for VaultError {
    fn from(error: rusqlite::Error) -> Self {
        use rusqlite::ffi;
        if let rusqlite::Error::SqliteFailure(failure, _) = &error {
            match failure.extended_code {
                // SQLite reports primary-key collisions as "UNIQUE constraint failed" too.
                ffi::SQLITE_CONSTRAINT_UNIQUE | ffi::SQLITE_CONSTRAINT_PRIMARYKEY => {
                    return Self::already_exists("That record already exists.").with_detail(&error);
                }
                ffi::SQLITE_CONSTRAINT_FOREIGNKEY => {
                    return Self::not_found("The related record was not found.")
                        .with_detail(&error);
                }
                _ => {}
            }
        }
        Self::unavailable().with_detail(&error)
    }
}

impl From<std::io::Error> for VaultError {
    fn from(error: std::io::Error) -> Self {
        Self::unavailable().with_detail(&error)
    }
}

/// Mirrors `logIpcFailure`: operation, code and message, never payload contents.
pub fn log_failure(operation: &str, error: &VaultError) {
    match &error.detail {
        Some(detail) => eprintln!(
            "[vault] {operation} failed ({}): {} [{detail}]",
            error.code.as_str(),
            error.message
        ),
        None => eprintln!(
            "[vault] {operation} failed ({}): {}",
            error.code.as_str(),
            error.message
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialises_to_the_frontend_contract() {
        let json = serde_json::to_value(
            VaultError::invalid_input("Invalid email.").with_detail("secret detail"),
        )
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "code": "INVALID_INPUT", "message": "Invalid email." })
        );
    }
}
