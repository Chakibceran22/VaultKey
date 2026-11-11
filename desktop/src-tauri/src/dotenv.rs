//! Reads a `.env` file into secrets: one per `NAME=value` line, and the comment on the
//! same line (`NAME=value # what it is`) as its description.
//!
//! The common dotenv format:
//! - blank lines and `# …` lines are skipped; `export NAME=value` works too;
//! - `"double quotes"` understand `\n`, `\t`, `\"`, `\\`; `'single'` and `` `backtick` ``
//!   quotes are taken as written; any quoted value may span lines (a private key);
//! - unquoted, a comment starts at a `#` that begins the value or follows a space, so a
//!   password like `p@ss#word` stays whole;
//! - a name set twice keeps its last value, as dotenv does.
//!
//! Nothing is guessed: a line that can't be read is listed with why, never dropped.

use std::{fs, path::Path};

use serde::Serialize;

use crate::error::{VaultError, VaultResult};
use crate::validation::{MAX_DESCRIPTION, MAX_SECRET_TEXT_BYTES};

/// The largest file read as a .env: far more than any real one.
const MAX_FILE_BYTES: u64 = 1024 * 1024;

/// The longest secret name the vault keeps (`validate_name(…, 200)`).
const MAX_NAME: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvEntry {
    /// Where it starts in the file, from 1.
    pub line: usize,
    pub name: String,
    pub value: String,
    /// The comment on its line, without the `#`: its description.
    pub comment: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvSkipped {
    pub line: usize,
    pub reason: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvFile {
    pub entries: Vec<EnvEntry>,
    /// Lines that hold something but give no secret, in file order.
    pub skipped: Vec<EnvSkipped>,
}

fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

/// Where the unescaped closing quote is: backslashes escape in double quotes only.
fn closing(text: &str, quote: char) -> Option<usize> {
    let mut escaped = false;
    for (at, c) in text.char_indices() {
        if quote == '"' && !escaped && c == '\\' {
            escaped = true;
            continue;
        }
        if c == quote && !escaped {
            return Some(at);
        }
        escaped = false;
    }
    None
}

fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

/// A comment as a description: `## what it is ` → "what it is", at most 2000 characters.
fn description(comment: &str) -> String {
    comment
        .trim_start_matches(|c: char| c == '#' || c.is_whitespace())
        .trim_end()
        .chars()
        .take(MAX_DESCRIPTION)
        .collect()
}

/// Where an unquoted value's comment starts: a `#` first, or after whitespace.
fn comment_start(value: &str) -> Option<usize> {
    let mut previous: Option<char> = None;
    for (at, c) in value.char_indices() {
        if c == '#' && previous.is_none_or(char::is_whitespace) {
            return Some(at);
        }
        previous = Some(c);
    }
    None
}

/// A .env file's name and text, for the import dialog.
#[derive(Debug, Serialize)]
pub struct EnvText {
    pub name: String,
    pub text: String,
}

/// A chosen or dropped file's text: a file, at most 1 MB, UTF-8.
pub fn read_text(path: &Path) -> VaultResult<EnvText> {
    let unreadable = |_| VaultError::invalid_input("That file can't be read.");
    let metadata = fs::metadata(path).map_err(unreadable)?;
    if !metadata.is_file() {
        return Err(VaultError::invalid_input("That is a folder, not a .env file."));
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err(VaultError::invalid_input("That file is larger than 1 MB, so it isn't a .env file."));
    }
    let text = String::from_utf8(fs::read(path).map_err(unreadable)?)
        .map_err(|_| VaultError::invalid_input("That file isn't text, so it isn't a .env file."))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(EnvText { name, text })
}

pub fn parse(text: &str) -> EnvFile {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    let mut skipped = Vec::new();
    let mut entries: Vec<EnvEntry> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let number = i + 1;
        let line = lines[i].trim();
        i += 1;
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").map_or(line, str::trim_start);
        let Some((name, rest)) = line.split_once('=') else {
            skipped.push(file_skip(number, "Not a NAME=value line."));
            continue;
        };
        let name = name.trim();
        if !valid_name(name) {
            skipped.push(file_skip(number, "Its name can only use letters, digits, _ . and -, not starting with a digit."));
            continue;
        }
        let rest = rest.trim_start();
        let (value, comment) = match rest.chars().next() {
            Some(quote @ ('"' | '\'' | '`')) => {
                let mut body = String::new();
                let mut current = &rest[1..];
                let mut after = None;
                loop {
                    if let Some(end) = closing(current, quote) {
                        body.push_str(&current[..end]);
                        after = Some(&current[end + 1..]);
                        break;
                    }
                    body.push_str(current);
                    let Some(next) = lines.get(i) else { break };
                    body.push('\n');
                    current = next;
                    i += 1;
                }
                let Some(after) = after.map(str::trim) else {
                    skipped.push(file_skip(number, "Its opening quote is never closed."));
                    // Read on from the next line: the rest of the file is not its value.
                    i = number;
                    continue;
                };
                if !after.is_empty() && !after.starts_with('#') {
                    skipped.push(file_skip(number, "Unexpected text after the closing quote."));
                    continue;
                }
                let value = if quote == '"' { unescape(&body) } else { body };
                (value, description(after))
            }
            _ => match comment_start(rest) {
                Some(at) => (rest[..at].trim_end().to_owned(), description(&rest[at..])),
                None => (rest.trim_end().to_owned(), String::new()),
            },
        };
        if name.len() > MAX_NAME {
            skipped.push(file_skip(number, "Its name is longer than 200 characters."));
        } else if value.is_empty() {
            skipped.push(file_skip(number, &format!("{name} has no value.")));
        } else if value.len() > MAX_SECRET_TEXT_BYTES {
            skipped.push(file_skip(number, &format!("{name} is longer than 64 KB. Add it as a file instead.")));
        } else {
            entries.push(EnvEntry { line: number, name: name.to_owned(), value, comment });
        }
    }
    // A name set twice keeps its last value.
    for (at, entry) in entries.iter().enumerate() {
        if let Some(later) = entries[at + 1..].iter().find(|e| e.name == entry.name) {
            skipped.push(file_skip(entry.line, &format!("{} is set again on line {}, which is kept.", entry.name, later.line)));
        }
    }
    entries.retain(|entry| !skipped.iter().any(|s| s.line == entry.line));
    skipped.sort_by_key(|s| s.line);
    EnvFile { entries, skipped }
}

fn file_skip(line: usize, reason: &str) -> EnvSkipped {
    EnvSkipped { line, reason: reason.to_owned() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(text: &str) -> (String, String) {
        let file = parse(text);
        assert!(file.skipped.is_empty(), "skipped: {:?}", file.skipped);
        assert_eq!(file.entries.len(), 1, "{:?}", file.entries);
        (file.entries[0].value.clone(), file.entries[0].comment.clone())
    }

    #[test]
    fn same_line_comments_become_descriptions() {
        let file = parse(
            "# Stripe\nSTRIPE_SECRET_KEY=sk_live_123 # live payments, full write access\n\nexport DATABASE_URL=postgres://u:p@h/db\n",
        );
        assert!(file.skipped.is_empty());
        assert_eq!(
            file.entries,
            [
                EnvEntry { line: 2, name: "STRIPE_SECRET_KEY".into(), value: "sk_live_123".into(), comment: "live payments, full write access".into() },
                EnvEntry { line: 4, name: "DATABASE_URL".into(), value: "postgres://u:p@h/db".into(), comment: String::new() },
            ]
        );
    }

    #[test]
    fn a_hash_inside_a_value_is_not_a_comment() {
        assert_eq!(one("PASSWORD=p@ss#word"), ("p@ss#word".into(), String::new()));
        assert_eq!(one("URL=https://x.io/#/a  # the app"), ("https://x.io/#/a".into(), "the app".into()));
        assert_eq!(one("A=\"has # inside\" # real comment"), ("has # inside".into(), "real comment".into()));
        assert_eq!(one("TOKEN=abc ## two hashes"), ("abc".into(), "two hashes".into()));
    }

    #[test]
    fn reads_quotes_like_dotenv() {
        assert_eq!(one(r#"A="line1\nline2 \"q\" \\ \x""#).0, "line1\nline2 \"q\" \\ \\x");
        assert_eq!(one(r"A='raw \n kept'").0, r"raw \n kept");
        assert_eq!(one("A=`back tick`").0, "back tick");
        assert_eq!(one("A = spaced value   ").0, "spaced value");
        assert_eq!(one("A=x=y=z").0, "x=y=z");
        assert_eq!(one("\u{feff}A=1\r\n").0, "1");
    }

    #[test]
    fn a_quoted_value_may_span_lines() {
        let file = parse("KEY=\"-----BEGIN KEY-----\nabc\n-----END KEY-----\" # deploy key\nNEXT=1");
        assert_eq!(file.entries[0].value, "-----BEGIN KEY-----\nabc\n-----END KEY-----");
        assert_eq!(file.entries[0].comment, "deploy key");
        assert_eq!((file.entries[1].line, file.entries[1].name.as_str()), (4, "NEXT"));
    }

    #[test]
    fn lists_what_it_cannot_read() {
        let file = parse("just words\n1BAD=x\nEMPTY=\nQUOTE=\"never closed\nOK=1\nTRAIL='a'b\nDUP=first\nDUP=second");
        let reasons: Vec<(usize, &str)> = file.skipped.iter().map(|s| (s.line, s.reason.as_str())).collect();
        assert_eq!(
            reasons,
            [
                (1, "Not a NAME=value line."),
                (2, "Its name can only use letters, digits, _ . and -, not starting with a digit."),
                (3, "EMPTY has no value."),
                (4, "Its opening quote is never closed."),
                (6, "Unexpected text after the closing quote."),
                (7, "DUP is set again on line 8, which is kept."),
            ]
        );
        // The unclosed quote did not swallow the lines after it.
        let kept: Vec<(&str, &str)> = file.entries.iter().map(|e| (e.name.as_str(), e.value.as_str())).collect();
        assert_eq!(kept, [("OK", "1"), ("DUP", "second")]);
    }

    #[test]
    fn caps_long_comments_and_values() {
        let long = "x".repeat(MAX_SECRET_TEXT_BYTES + 1);
        assert_eq!(parse(&format!("BIG={long}")).skipped[0].reason, "BIG is longer than 64 KB. Add it as a file instead.");
        let comment = "y".repeat(MAX_DESCRIPTION + 50);
        assert_eq!(one(&format!("A=1 # {comment}")).1.len(), MAX_DESCRIPTION);
    }
}
