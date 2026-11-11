//! The app's end: listens where the bridge connects (`address`) and answers it.
//!
//! Each connection, in order:
//! 1. `state` (locked, unlocked or disabled), then again the moment it changes.
//! 2. Pairing, when a browser asks: `pair.request` → `pair.pending` (both sides now show
//!    the 6-digit code) → `pair.result`, once the user answered in VaultKey.
//! 3. A session with a paired browser: `hs1` → `hs2` (Noise KK), then encrypted `x`
//!    frames both ways. Locking the vault ends it (`locked`), and so does removing the
//!    browser's pairing (`revoked`).
//!
//! Anything out of turn is refused with `err` and the connection closed. What the app
//! knows (the vault's state, its keys, the pairing dialog) is behind [`App`].

use std::{io, sync::Arc, time::Duration};

use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::{Semaphore, mpsc, oneshot, watch},
    time::Instant,
};

use crate::{
    address::Address,
    api::{self, AuthCode, Entry, Fill, Grants, Limiter, Login},
    frame::{self, ByteOrder},
    inner,
    message::{self, Browser, ErrorCode, Message, PROTOCOL, VaultState},
    noise::{self, ClientId, PrivateKey, PublicKey},
};

/// What the app says about itself; [`App::status`] also reports each change.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Status {
    pub vault: VaultState,
    /// Bumped whenever a pairing is removed: live sessions check that theirs still holds.
    pub pairings: u64,
    /// Bumped by every lock, and by turning the extension off: each ends every session
    /// and pairing request, even when undone before a connection looked (a quick lock
    /// and unlock is still a lock).
    pub resets: u64,
}

/// Why the app said no.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    Locked,
    Disabled,
    /// A pairing dialog is already open.
    Busy,
    /// Anything else (a database error): the details go to the app's log.
    Internal,
}

impl Refusal {
    fn code(self) -> ErrorCode {
        match self {
            Refusal::Locked => ErrorCode::Locked,
            Refusal::Disabled => ErrorCode::Disabled,
            Refusal::Busy => ErrorCode::Busy,
            Refusal::Internal => ErrorCode::Internal,
        }
    }
}

/// A browser asking to pair, as the dialog shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PairingRequest {
    pub public_key: PublicKey,
    pub name: String,
    pub browser: Browser,
    /// The 6-digit code the popup shows too.
    pub code: String,
}

/// What the server needs from the app. The methods that read the vault may block
/// briefly; the server calls them off the async threads.
pub trait App: Send + Sync + 'static {
    /// The current status, and its changes.
    fn status(&self) -> watch::Receiver<Status>;
    /// VaultKey's own X25519 private key (enabled and unlocked only).
    fn static_key(&self) -> Result<PrivateKey, Refusal>;
    /// A paired browser's public key by its client id, or `None` if it isn't paired.
    fn client_key(&self, client: &ClientId) -> Result<Option<PublicKey>, Refusal>;
    /// Opens the pairing dialog. The answer comes on the receiver: `true` once the browser
    /// is saved as paired. When the receiver is dropped (no answer in time, the connection
    /// closed, the vault locked), the dialog must close.
    fn ask_to_pair(&self, request: PairingRequest) -> Result<oneshot::Receiver<bool>, Refusal>;
    /// A paired browser completed a handshake ("last used").
    fn seen(&self, client: &ClientId);
    /// Every account, without secrets, websites normalised (the app caches this).
    fn accounts(&self) -> Result<Arc<[Entry]>, Refusal>;
    /// One account's login, decrypted for one fill.
    fn login(&self, account: i64) -> Result<Option<Login>, Refusal>;
    /// One account's current authenticator code, if it has a setup key.
    fn code(&self, account: i64) -> Result<Option<AuthCode>, Refusal>;
    /// A fill happened: for "Recent fills" in Settings (memory only).
    fn filled(&self, fill: Fill);
    /// Brings VaultKey's window forward (to unlock it there).
    fn open_window(&self);
}

/// Bridges connected at once: a few browsers with a few profiles each. More are turned
/// away, so a misbehaving local program can't pile up connections.
const MAX_CONNECTIONS: usize = 16;

/// How long a pairing dialog waits for an answer.
pub const PAIRING_TIMEOUT: Duration = Duration::from_secs(120);

/// A bound, private listening address. Dropping it stops listening (and, on Unix,
/// removes the socket file).
pub struct Listener(imp::Listener);

/// Binds `address`. Fails when another VaultKey (of the same flavor) already listens.
///
/// Must run inside a tokio runtime with I/O enabled.
pub fn bind(address: &Address) -> io::Result<Listener> {
    match address {
        #[cfg(unix)]
        Address::Socket(path) => imp::Listener::bind(path).map(Listener),
        #[cfg(windows)]
        Address::Pipe(name) => imp::Listener::bind(name).map(Listener),
    }
}

/// Accepts bridges until the task is dropped, one task per connection. Waits only:
/// no CPU while nothing happens. Dropping this task stops new connections; the open
/// ones end themselves when the app reports `disabled`.
pub async fn serve(mut listener: Listener, app: Arc<dyn App>) {
    let permits = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    // Rate limits are per paired browser, across all its connections.
    let limiter = Arc::new(Limiter::default());
    loop {
        let stream = match listener.0.accept().await {
            Ok(stream) => stream,
            Err(error) => {
                // Out of file descriptors and the like: pass, rather than spin or stop.
                eprintln!("[bridge] accept failed: {error}");
                tokio::time::sleep(Duration::from_millis(250)).await;
                continue;
            }
        };
        let Ok(permit) = Arc::clone(&permits).try_acquire_owned() else {
            drop(stream);
            continue;
        };
        let app = Arc::clone(&app);
        let limiter = Arc::clone(&limiter);
        tokio::spawn(async move {
            // A broken connection ends just that connection; the bridge reconnects.
            let _ = handle_with(stream, app, limiter).await;
            drop(permit);
        });
    }
}

/// One bridge connection, until it closes or is refused (with its own rate limits).
pub async fn handle<S>(stream: S, app: Arc<dyn App>) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    handle_with(stream, app, Arc::new(Limiter::default())).await
}

async fn handle_with<S>(stream: S, app: Arc<dyn App>, limiter: Arc<Limiter>) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let (mut reader, writer) = tokio::io::split(stream);
    // Frames are read on their own task (`read_frame` isn't cancel-safe), so waiting on
    // the vault's state or the user's answer never cuts one in half.
    let (frames_in, frames) = mpsc::channel(4);
    let reading = tokio::spawn(async move {
        while let Ok(Some(frame)) = frame::read_frame(&mut reader, ByteOrder::Little).await {
            if frames_in.send(frame).await.is_err() {
                break;
            }
        }
    });
    let mut status = app.status();
    let told = *status.borrow_and_update();
    let connection = Connection { writer, app, limiter, status, told, session: None, pairing: None };
    let result = connection.run(frames).await;
    reading.abort();
    result
}

struct Session {
    client: ClientId,
    transport: noise::Transport,
    /// The handles this session was given.
    grants: Grants,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Flow {
    Continue,
    Close,
}

type Step = io::Result<Flow>;

struct Connection<W> {
    writer: W,
    app: Arc<dyn App>,
    limiter: Arc<Limiter>,
    status: watch::Receiver<Status>,
    /// What this connection last told the extension.
    told: Status,
    session: Option<Session>,
    /// The pairing dialog this connection opened: the user's answer, and until when to
    /// wait for it.
    pairing: Option<(oneshot::Receiver<bool>, Instant)>,
}

/// Runs `job` (which may read the vault) on a blocking thread.
pub(crate) async fn blocking<T, F>(app: &Arc<dyn App>, job: F) -> Result<T, Refusal>
where
    T: Send + 'static,
    F: FnOnce(&dyn App) -> Result<T, Refusal> + Send + 'static,
{
    let app = Arc::clone(app);
    tokio::task::spawn_blocking(move || job(app.as_ref()))
        .await
        .unwrap_or(Err(Refusal::Internal))
}

/// The user's answer to this connection's pairing dialog; never resolves without one.
/// No answer in time counts as "no".
async fn decision(pairing: &mut Option<(oneshot::Receiver<bool>, Instant)>) -> bool {
    match pairing {
        Some((answer, deadline)) => tokio::time::timeout_at(*deadline, answer)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or(false),
        None => std::future::pending().await,
    }
}

impl<W: AsyncWrite + Unpin> Connection<W> {
    async fn run(mut self, mut frames: mpsc::Receiver<Vec<u8>>) -> io::Result<()> {
        self.send(&Message::State { state: self.told.vault, protocol: PROTOCOL }).await?;
        if self.told.vault == VaultState::Disabled {
            return Ok(());
        }
        loop {
            let flow = tokio::select! {
                // In this order when several are ready: a user's answer is delivered
                // before a lock that came after it, and a lock acts before any request.
                biased;
                approved = decision(&mut self.pairing) => {
                    self.pairing = None;
                    self.send(&Message::PairResult { approved }).await?;
                    Flow::Continue
                }
                changed = self.status.changed() => match changed {
                    Ok(()) => {
                        let now = *self.status.borrow_and_update();
                        self.on_status(now).await?
                    }
                    // The app is shutting down.
                    Err(_) => Flow::Close,
                },
                frame = frames.recv() => match frame {
                    Some(frame) => self.on_frame(&frame).await?,
                    None => Flow::Close,
                },
            };
            if flow == Flow::Close {
                return Ok(());
            }
        }
    }

    async fn on_frame(&mut self, frame: &[u8]) -> Step {
        match Message::from_bytes(frame) {
            Ok(Message::Ping { n }) => {
                self.send(&Message::Pong { n }).await?;
                Ok(Flow::Continue)
            }
            // Works locked: that's what it's for. The app limits how often.
            Ok(Message::AppShow {}) => {
                self.app.open_window();
                Ok(Flow::Continue)
            }
            Ok(Message::PairRequest { public, name, browser, protocol }) => {
                self.pair(&public, name, browser, protocol).await
            }
            Ok(Message::Hs1 { client, msg, protocol }) => self.handshake(&client, &msg, protocol).await,
            Ok(Message::X { c }) => self.inner(&c).await,
            // Malformed, or a message only the app or the bridge sends.
            _ => self.refuse(ErrorCode::BadFrame).await,
        }
    }

    /// Nothing happens while the vault is locked or the extension turned off.
    fn gate(&self) -> Option<ErrorCode> {
        match self.status.borrow().vault {
            VaultState::Unlocked => None,
            VaultState::Locked => Some(ErrorCode::Locked),
            VaultState::Disabled => Some(ErrorCode::Disabled),
        }
    }

    async fn pair(&mut self, public: &str, name: String, browser: Browser, protocol: u32) -> Step {
        if let Err(need) = message::check_version(protocol) {
            self.send(&Message::Err { code: ErrorCode::ProtocolVersion, need: Some(need) }).await?;
            return Ok(Flow::Close);
        }
        let (Some(public_key), true) = (message::decode_key(public), message::valid_name(&name)) else {
            return self.refuse(ErrorCode::BadFrame).await;
        };
        if self.pairing.is_some() {
            return self.refuse(ErrorCode::Busy).await;
        }
        if let Some(code) = self.gate() {
            return self.refuse(code).await;
        }
        let app_public = match blocking(&self.app, |app| app.static_key()).await {
            Ok(key) => noise::public_key(&key),
            Err(refusal) => return self.refuse(refusal.code()).await,
        };
        let code = noise::pairing_code(&public_key, &app_public);
        let answer = match self.app.ask_to_pair(PairingRequest { public_key, name, browser, code }) {
            Ok(answer) => answer,
            Err(refusal) => return self.refuse(refusal.code()).await,
        };
        self.send(&Message::PairPending { public: message::encode(&app_public) }).await?;
        self.pairing = Some((answer, Instant::now() + PAIRING_TIMEOUT));
        Ok(Flow::Continue)
    }

    async fn handshake(&mut self, client: &str, msg: &str, protocol: u32) -> Step {
        // Before the keys: a browser speaking another version must hear "update", not
        // "not paired" (which would make it forget its keys).
        if let Err(need) = message::check_version(protocol) {
            self.session = None;
            self.send(&Message::Err { code: ErrorCode::ProtocolVersion, need: Some(need) }).await?;
            return Ok(Flow::Close);
        }
        let (Some(client), Some(hello)) = (message::decode_client(client), message::decode(msg, noise::MAX_HANDSHAKE))
        else {
            return self.refuse(ErrorCode::BadFrame).await;
        };
        // A new handshake replaces this connection's session, whatever comes of it.
        self.session = None;
        if let Some(code) = self.gate() {
            return self.refuse(code).await;
        }
        let client_public = match blocking(&self.app, move |app| app.client_key(&client)).await {
            Ok(Some(key)) if noise::client_id(&key) == client => key,
            Ok(_) => return self.refuse(ErrorCode::NotPaired).await,
            Err(refusal) => return self.refuse(refusal.code()).await,
        };
        let app_key = match blocking(&self.app, |app| app.static_key()).await {
            Ok(key) => key,
            Err(refusal) => return self.refuse(refusal.code()).await,
        };
        // Fails when the browser holds another key for VaultKey (the app's key was made
        // again since it paired): it has to pair again.
        let Ok((answer, transport)) = noise::respond(&app_key, &client_public, &hello) else {
            return self.refuse(ErrorCode::NotPaired).await;
        };
        drop(app_key);
        self.send(&Message::Hs2 { msg: message::encode(&answer) }).await?;
        self.session = Some(Session { client, transport, grants: Grants::default() });
        let _ = blocking(&self.app, move |app| {
            app.seen(&client);
            Ok(())
        })
        .await;
        Ok(Flow::Continue)
    }

    async fn inner(&mut self, c: &str) -> Step {
        let Some(sealed) = message::decode(c, noise::MAX_PLAINTEXT + noise::TAG_LEN) else {
            return self.refuse(ErrorCode::BadFrame).await;
        };
        let opened = match self.session.as_mut() {
            Some(session) => session.transport.decrypt(&sealed).ok(),
            None => None,
        };
        // No session, or a frame replayed, reordered or altered: the session is over.
        let Some(plaintext) = opened else {
            self.session = None;
            return self.refuse(ErrorCode::BadFrame).await;
        };
        let Ok(request) = inner::Request::from_bytes(&plaintext) else {
            self.session = None;
            return self.refuse(ErrorCode::BadFrame).await;
        };
        let Some(session) = self.session.as_mut() else {
            return Ok(Flow::Continue);
        };
        let answer = api::answer(&self.app, session.client, &mut session.grants, &self.limiter, &request).await;
        self.send_inner(&answer).await?;
        Ok(Flow::Continue)
    }

    async fn on_status(&mut self, now: Status) -> Step {
        let before = std::mem::replace(&mut self.told, now);
        let reset = now.resets != before.resets;
        if reset || now.vault != VaultState::Unlocked {
            // Sessions and pairing need the vault open: say so inside the session first.
            if self.session.is_some() {
                self.send_inner(&inner::event(inner::Event::Locked)).await?;
                self.session = None;
            }
            if let Some((mut answer, _)) = self.pairing.take() {
                // An answer given just before is still the answer (the browser may be saved).
                let approved = answer.try_recv().unwrap_or(false);
                self.send(&Message::PairResult { approved }).await?;
            }
        }
        if reset || now.vault != before.vault {
            // Also after a lock undone at once: the browser hears its session ended, then
            // that the vault is open, and starts a new one.
            self.send(&Message::State { state: now.vault, protocol: PROTOCOL }).await?;
            if now.vault == VaultState::Disabled {
                return Ok(Flow::Close);
            }
        }
        if now.pairings != before.pairings
            && let Some(session) = &self.session
        {
            let client = session.client;
            match blocking(&self.app, move |app| app.client_key(&client)).await {
                Ok(Some(_)) => {}
                Ok(None) => {
                    self.send_inner(&inner::event(inner::Event::Revoked)).await?;
                    self.session = None;
                }
                // Can't tell whether it was revoked: end the connection rather than keep a
                // session that may not be allowed any more (the browser reconnects).
                Err(_) => {
                    self.session = None;
                    return Ok(Flow::Close);
                }
            }
        }
        Ok(Flow::Continue)
    }

    async fn refuse(&mut self, code: ErrorCode) -> Step {
        self.send(&Message::Err { code, need: None }).await?;
        Ok(Flow::Close)
    }

    async fn send(&mut self, message: &Message) -> io::Result<()> {
        frame::write_frame(&mut self.writer, ByteOrder::Little, &message.to_bytes()).await
    }

    /// Encrypts `plaintext` for this connection's session (nothing without one).
    async fn send_inner(&mut self, plaintext: &[u8]) -> io::Result<()> {
        let Some(session) = self.session.as_mut() else {
            return Ok(());
        };
        let sealed = session
            .transport
            .encrypt(plaintext)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        self.send(&Message::X { c: message::encode(&sealed) }).await
    }
}

#[cfg(unix)]
mod imp {
    use std::{
        fs, io,
        os::unix::fs::{FileTypeExt, PermissionsExt},
        path::{Path, PathBuf},
    };

    use tokio::net::{UnixListener, UnixStream};

    pub struct Listener {
        listener: UnixListener,
        path: PathBuf,
        /// Held while listening: proof that any socket file found at start is stale.
        _lock: fs::File,
    }

    impl Listener {
        pub fn bind(path: &Path) -> io::Result<Self> {
            let directory = path
                .parent()
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "the socket path has no folder"))?;
            fs::create_dir_all(directory)?;
            // Only this user may reach the socket: its folder is 0700, set even if it
            // already existed, before the socket is created inside it.
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
            let lock = fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(directory.join("socket.lock"))?;
            match lock.try_lock() {
                Ok(()) => {}
                Err(fs::TryLockError::WouldBlock) => {
                    return Err(io::Error::new(
                        io::ErrorKind::AddrInUse,
                        "another VaultKey is already listening for the extension",
                    ));
                }
                Err(fs::TryLockError::Error(error)) => return Err(error),
            }
            // Holding the lock, a socket here was left by a VaultKey that is gone. Anything
            // else at this path (a file, a link) isn't ours to delete.
            match fs::symlink_metadata(path) {
                Ok(metadata) if metadata.file_type().is_socket() => fs::remove_file(path)?,
                Ok(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::AlreadyExists,
                        format!("{} exists and is not a socket; not replacing it", path.display()),
                    ));
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            let listener = UnixListener::bind(path)?;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
            Ok(Self { listener, path: path.to_owned(), _lock: lock })
        }

        pub async fn accept(&mut self) -> io::Result<UnixStream> {
            Ok(self.listener.accept().await?.0)
        }
    }

    impl Drop for Listener {
        fn drop(&mut self) {
            // Before the lock is released (fields drop after this), so the next VaultKey
            // never sees a socket file that someone else still owns.
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(windows)]
mod imp {
    use std::io;

    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

    use crate::windows::UserOnly;

    /// Always one instance waiting for the next bridge. Only the current user may open
    /// it (an explicit, protected DACL: `windows.rs`), and remote clients are rejected.
    pub struct Listener {
        name: String,
        next: NamedPipeServer,
        security: UserOnly,
    }

    fn create(name: &str, security: &mut UserOnly, first: bool) -> io::Result<NamedPipeServer> {
        let mut options = ServerOptions::new();
        options.first_pipe_instance(first).reject_remote_clients(true);
        // SAFETY: `security` holds valid SECURITY_ATTRIBUTES and outlives the call, which
        // only reads them.
        unsafe { options.create_with_security_attributes_raw(name, security.as_raw()) }
    }

    impl Listener {
        pub fn bind(name: &str) -> io::Result<Self> {
            let mut security = UserOnly::new()?;
            // `first_pipe_instance`: fails if the name is already taken (another VaultKey,
            // or another user who created it first; the bridge checks the owner too).
            let next = create(name, &mut security, true)?;
            Ok(Self { name: name.to_owned(), next, security })
        }

        pub async fn accept(&mut self) -> io::Result<NamedPipeServer> {
            let connected = self.next.connect().await;
            // A fresh instance waits for the next bridge either way: one that failed to
            // connect isn't reused, since it could keep failing. If creating the fresh one
            // fails, the current instance stays and the next call tries again.
            let fresh = create(&self.name, &mut self.security, false)?;
            let current = std::mem::replace(&mut self.next, fresh);
            connected.map(|()| current)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::Mutex};

    use tokio::io::{DuplexStream, ReadHalf, WriteHalf};

    use super::*;
    use crate::message::Need;

    const UNLOCKED: Message = Message::State { state: VaultState::Unlocked, protocol: PROTOCOL };
    const LOCKED: Message = Message::State { state: VaultState::Locked, protocol: PROTOCOL };
    const DISABLED: Message = Message::State { state: VaultState::Disabled, protocol: PROTOCOL };

    fn refused(code: ErrorCode) -> Message {
        Message::Err { code, need: None }
    }

    /// VaultKey, in memory: a vault that locks and unlocks, paired browsers, and a
    /// pairing dialog the test answers.
    struct FakeApp {
        status: watch::Sender<Status>,
        key: PrivateKey,
        clients: Mutex<HashMap<ClientId, PublicKey>>,
        dialogs: Mutex<Vec<(PairingRequest, oneshot::Sender<bool>)>>,
        seen: Mutex<Vec<ClientId>>,
        /// The vault's lookups fail (a database error).
        broken: std::sync::atomic::AtomicBool,
        shown: Mutex<u32>,
    }

    impl FakeApp {
        fn new(vault: VaultState) -> Arc<Self> {
            Arc::new(Self {
                status: watch::Sender::new(Status { vault, pairings: 0, resets: 0 }),
                key: noise::generate_keypair().0,
                clients: Mutex::default(),
                dialogs: Mutex::default(),
                seen: Mutex::default(),
                broken: Default::default(),
                shown: Mutex::default(),
            })
        }

        fn public(&self) -> PublicKey {
            noise::public_key(&self.key)
        }

        fn set(&self, vault: VaultState) {
            self.status.send_modify(|status| {
                if vault != VaultState::Unlocked {
                    status.resets += 1;
                }
                status.vault = vault;
            });
        }

        /// Locked and unlocked again before any connection looked.
        fn lock_and_unlock(&self) {
            self.status.send_modify(|status| status.resets += 1);
        }

        fn pair(&self, public: PublicKey) {
            self.clients.lock().unwrap().insert(noise::client_id(&public), public);
        }

        fn revoke(&self, public: &PublicKey) {
            self.clients.lock().unwrap().remove(&noise::client_id(public));
            self.status.send_modify(|status| status.pairings += 1);
        }

        fn open_dialogs(&self) -> usize {
            let mut dialogs = self.dialogs.lock().unwrap();
            dialogs.retain(|(_, answer)| !answer.is_closed());
            dialogs.len()
        }

        /// Answers the open dialog, as the user would; returns what it showed.
        fn answer(&self, approve: bool) -> PairingRequest {
            assert_eq!(self.open_dialogs(), 1, "one pairing dialog is open");
            let (request, answer) = self.dialogs.lock().unwrap().pop().unwrap();
            if approve {
                self.pair(request.public_key);
            }
            answer.send(approve).unwrap();
            request
        }

        fn unlocked(&self) -> Result<(), Refusal> {
            match self.status.borrow().vault {
                VaultState::Unlocked => Ok(()),
                VaultState::Locked => Err(Refusal::Locked),
                VaultState::Disabled => Err(Refusal::Disabled),
            }
        }
    }

    impl App for FakeApp {
        fn status(&self) -> watch::Receiver<Status> {
            self.status.subscribe()
        }

        fn static_key(&self) -> Result<PrivateKey, Refusal> {
            self.unlocked().map(|()| self.key.clone())
        }

        fn client_key(&self, client: &ClientId) -> Result<Option<PublicKey>, Refusal> {
            self.unlocked()?;
            if self.broken.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(Refusal::Internal);
            }
            Ok(self.clients.lock().unwrap().get(client).copied())
        }

        fn ask_to_pair(&self, request: PairingRequest) -> Result<oneshot::Receiver<bool>, Refusal> {
            if self.open_dialogs() > 0 {
                return Err(Refusal::Busy);
            }
            let (answer, receiver) = oneshot::channel();
            self.dialogs.lock().unwrap().push((request, answer));
            Ok(receiver)
        }

        fn seen(&self, client: &ClientId) {
            self.seen.lock().unwrap().push(*client);
        }

        fn accounts(&self) -> Result<Arc<[Entry]>, Refusal> {
            self.unlocked()?;
            Ok(Arc::from(Vec::new()))
        }

        fn login(&self, _: i64) -> Result<Option<Login>, Refusal> {
            Ok(None)
        }

        fn code(&self, _: i64) -> Result<Option<AuthCode>, Refusal> {
            Ok(None)
        }

        fn filled(&self, _: Fill) {}

        fn open_window(&self) {
            *self.shown.lock().unwrap() += 1;
        }
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
    }

    /// Every read is bounded: a server that stops answering fails the test, not hangs it.
    async fn read<R: AsyncRead + Unpin>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
        tokio::time::timeout(Duration::from_secs(5), frame::read_frame(reader, ByteOrder::Little))
            .await
            .expect("the server answered within 5 s")
    }

    async fn next_on<R: AsyncRead + Unpin>(reader: &mut R) -> Message {
        let frame = read(reader).await.unwrap().expect("a frame, not a closed connection");
        Message::from_bytes(&frame).unwrap()
    }

    /// The extension's end of one connection.
    struct Extension {
        reader: ReadHalf<DuplexStream>,
        writer: WriteHalf<DuplexStream>,
        task: tokio::task::JoinHandle<io::Result<()>>,
    }

    impl Extension {
        fn connect(app: &Arc<FakeApp>) -> Self {
            let (client, server) = tokio::io::duplex(1 << 17);
            let task = tokio::spawn(handle(server, Arc::clone(app) as Arc<dyn App>));
            let (reader, writer) = tokio::io::split(client);
            Self { reader, writer, task }
        }

        async fn send_raw(&mut self, json: &str) {
            frame::write_frame(&mut self.writer, ByteOrder::Little, json.as_bytes()).await.unwrap();
        }

        async fn send(&mut self, message: &Message) {
            frame::write_frame(&mut self.writer, ByteOrder::Little, &message.to_bytes()).await.unwrap();
        }

        async fn next(&mut self) -> Message {
            next_on(&mut self.reader).await
        }

        /// The server closed the connection (after refusing something) and its task ended.
        async fn closed(self) {
            let Extension { mut reader, writer, task } = self;
            let end = read(&mut reader).await;
            assert!(matches!(end, Ok(None)), "expected the connection to close, got {end:?}");
            drop((reader, writer));
            tokio::time::timeout(Duration::from_secs(5), task)
                .await
                .expect("the server ended the connection")
                .unwrap()
                .unwrap();
        }

        async fn ask_to_pair(&mut self, public: &PublicKey, protocol: u32) -> Message {
            self.send(&Message::PairRequest {
                public: message::encode(public),
                name: "Brave on macOS".into(),
                browser: Browser::Brave,
                protocol,
            })
            .await;
            self.next().await
        }

        async fn hs1(&mut self, key: &[u8; noise::KEY_LEN], app: &PublicKey) -> noise::Initiator {
            self.hs1_speaking(key, app, PROTOCOL).await
        }

        async fn hs1_speaking(&mut self, key: &[u8; noise::KEY_LEN], app: &PublicKey, protocol: u32) -> noise::Initiator {
            let (initiator, hello) = noise::Initiator::start(key, app).unwrap();
            let client = noise::client_id(&noise::public_key(key));
            self.send(&Message::Hs1 { client: message::encode(&client), msg: message::encode(&hello), protocol }).await;
            initiator
        }

        async fn session(&mut self, key: &[u8; noise::KEY_LEN], app: &PublicKey) -> noise::Transport {
            let initiator = self.hs1(key, app).await;
            let Message::Hs2 { msg } = self.next().await else { panic!("expected hs2") };
            initiator.finish(&message::decode(&msg, noise::MAX_HANDSHAKE).unwrap()).unwrap()
        }

        async fn send_x(&mut self, session: &mut noise::Transport, json: &str) -> Vec<u8> {
            let sealed = session.encrypt(json.as_bytes()).unwrap();
            self.send(&Message::X { c: message::encode(&sealed) }).await;
            sealed
        }

        async fn receive_x(&mut self, session: &mut noise::Transport) -> String {
            let Message::X { c } = self.next().await else { panic!("expected an encrypted frame") };
            let sealed = message::decode(&c, frame::MAX_FRAME).unwrap();
            String::from_utf8(session.decrypt(&sealed).unwrap().to_vec()).unwrap()
        }

        async fn call(&mut self, session: &mut noise::Transport, json: &str) -> String {
            self.send_x(session, json).await;
            self.receive_x(session).await
        }
    }

    #[test]
    fn says_the_state_then_pushes_each_change_at_once() {
        runtime().block_on(async {
            let app = FakeApp::new(VaultState::Locked);
            let mut extension = Extension::connect(&app);
            assert_eq!(extension.next().await, LOCKED);
            extension.send_raw(r#"{"t":"ping","n":1}"#).await;
            assert_eq!(extension.next().await, Message::Pong { n: 1 });

            // No ping needed: the change arrives by itself.
            app.set(VaultState::Unlocked);
            assert_eq!(extension.next().await, UNLOCKED);
            app.set(VaultState::Locked);
            assert_eq!(extension.next().await, LOCKED);

            // Turned off: said, then the connection closes.
            app.set(VaultState::Disabled);
            assert_eq!(extension.next().await, DISABLED);
            extension.closed().await;

            // And a connection made while it's off hears just that.
            let mut late = Extension::connect(&app);
            assert_eq!(late.next().await, DISABLED);
            late.closed().await;
        });
    }

    #[test]
    fn refuses_anything_out_of_turn_and_closes() {
        runtime().block_on(async {
            for bad in [
                r#"{"t":"pong","n":1}"#,
                r#"{"t":"reveal","h":"x"}"#,
                r#"["ping",7]"#,
                "nonsense",
                r#"{"t":"state","state":"unlocked","protocol":1}"#,
                r#"{"t":"pair.pending","pub":"AA=="}"#,
                r#"{"t":"hs2","msg":"AA=="}"#,
                // Encrypted frames before any session.
                r#"{"t":"x","c":"AAAAAAAAAAAAAAAAAAAAAA=="}"#,
                // Not base64, or not 32 bytes.
                r#"{"t":"pair.request","pub":"!!","name":"x","browser":"brave","protocol":1}"#,
                r#"{"t":"pair.request","pub":"AA==","name":"x","browser":"brave","protocol":1}"#,
                r#"{"t":"hs1","client":"AA==","msg":"AA==","protocol":1}"#,
            ] {
                let app = FakeApp::new(VaultState::Unlocked);
                let mut extension = Extension::connect(&app);
                assert_eq!(extension.next().await, UNLOCKED);
                extension.send_raw(bad).await;
                assert_eq!(extension.next().await, refused(ErrorCode::BadFrame), "{bad}");
                extension.closed().await;
            }
            // A name the dialog wouldn't show as is.
            let app = FakeApp::new(VaultState::Unlocked);
            let mut extension = Extension::connect(&app);
            extension.next().await;
            let key = message::encode(&[9; 32]);
            extension
                .send_raw(&format!(r#"{{"t":"pair.request","pub":"{key}","name":" spaced ","browser":"brave","protocol":1}}"#))
                .await;
            assert_eq!(extension.next().await, refused(ErrorCode::BadFrame));
            extension.closed().await;
        });
    }

    #[test]
    fn pairs_when_the_user_approves_then_opens_a_session() {
        runtime().block_on(async {
            let app = FakeApp::new(VaultState::Unlocked);
            let (key, public) = noise::generate_keypair();
            let mut extension = Extension::connect(&app);
            assert_eq!(extension.next().await, UNLOCKED);

            assert_eq!(
                extension.ask_to_pair(&public, PROTOCOL).await,
                Message::PairPending { public: message::encode(&app.public()) }
            );
            // VaultKey's dialog shows the same code the popup computes from both keys.
            let shown = app.answer(true);
            assert_eq!(shown.public_key, public);
            assert_eq!(shown.name, "Brave on macOS");
            assert_eq!(shown.browser, Browser::Brave);
            assert_eq!(shown.code, noise::pairing_code(&public, &app.public()));
            assert_eq!(extension.next().await, Message::PairResult { approved: true });

            let mut session = extension.session(&key, &app.public()).await;
            assert_eq!(extension.call(&mut session, r#"{"id":1,"m":"ping"}"#).await, r#"{"id":1,"ok":true,"r":{}}"#);
            assert_eq!(
                extension.call(&mut session, r#"{"id":2,"m":"reveal","p":{"h":"x"}}"#).await,
                r#"{"id":2,"ok":false,"e":{"code":"BAD_REQUEST","msg":"Unknown method or parameters."}}"#
            );
            assert_eq!(*app.seen.lock().unwrap(), [noise::client_id(&public)]);
            // Plaintext pings still work alongside the session.
            extension.send_raw(r#"{"t":"ping","n":3}"#).await;
            assert_eq!(extension.next().await, Message::Pong { n: 3 });
        });
    }

    #[test]
    fn a_declined_pairing_gives_nothing() {
        runtime().block_on(async {
            let app = FakeApp::new(VaultState::Unlocked);
            let (key, public) = noise::generate_keypair();
            let mut extension = Extension::connect(&app);
            extension.next().await;
            assert!(matches!(extension.ask_to_pair(&public, PROTOCOL).await, Message::PairPending { .. }));
            app.answer(false);
            assert_eq!(extension.next().await, Message::PairResult { approved: false });

            let _ = extension.hs1(&key, &app.public()).await;
            assert_eq!(extension.next().await, refused(ErrorCode::NotPaired));
            extension.closed().await;
        });
    }

    #[test]
    fn pairing_needs_the_vault_unlocked_and_one_dialog_at_a_time() {
        runtime().block_on(async {
            let public = noise::generate_keypair().1;

            let locked = FakeApp::new(VaultState::Locked);
            let mut extension = Extension::connect(&locked);
            assert_eq!(extension.next().await, LOCKED);
            assert_eq!(extension.ask_to_pair(&public, PROTOCOL).await, refused(ErrorCode::Locked));
            extension.closed().await;

            let app = FakeApp::new(VaultState::Unlocked);
            let mut first = Extension::connect(&app);
            first.next().await;
            assert!(matches!(first.ask_to_pair(&public, PROTOCOL).await, Message::PairPending { .. }));
            // Another browser while the dialog is open.
            let mut second = Extension::connect(&app);
            second.next().await;
            assert_eq!(second.ask_to_pair(&noise::generate_keypair().1, PROTOCOL).await, refused(ErrorCode::Busy));
            second.closed().await;

            // Locking closes the dialog: "no", then the new state.
            app.set(VaultState::Locked);
            assert_eq!(first.next().await, Message::PairResult { approved: false });
            assert_eq!(first.next().await, LOCKED);
            assert_eq!(app.open_dialogs(), 0);

            // The same connection asking twice.
            app.set(VaultState::Unlocked);
            assert_eq!(first.next().await, UNLOCKED);
            assert!(matches!(first.ask_to_pair(&public, PROTOCOL).await, Message::PairPending { .. }));
            assert_eq!(first.ask_to_pair(&public, PROTOCOL).await, refused(ErrorCode::Busy));
            first.closed().await;
            // Its dialog went with it.
            assert_eq!(app.open_dialogs(), 0);
        });
    }

    #[test]
    fn an_unanswered_pairing_times_out() {
        runtime().block_on(async {
            let app = FakeApp::new(VaultState::Unlocked);
            let mut extension = Extension::connect(&app);
            extension.next().await;
            assert!(matches!(
                extension.ask_to_pair(&noise::generate_keypair().1, PROTOCOL).await,
                Message::PairPending { .. }
            ));
            tokio::time::pause();
            tokio::time::advance(PAIRING_TIMEOUT + Duration::from_secs(1)).await;
            let frame = frame::read_frame(&mut extension.reader, ByteOrder::Little).await.unwrap().unwrap();
            assert_eq!(Message::from_bytes(&frame).unwrap(), Message::PairResult { approved: false });
            assert_eq!(app.open_dialogs(), 0);
        });
    }

    #[test]
    fn protocol_versions_are_checked_before_anything_else() {
        runtime().block_on(async {
            let app = FakeApp::new(VaultState::Locked);
            for (version, need) in [(PROTOCOL + 1, Need::UpdateApp), (0, Need::UpdateExtension)] {
                let mut extension = Extension::connect(&app);
                extension.next().await;
                assert_eq!(
                    extension.ask_to_pair(&noise::generate_keypair().1, version).await,
                    Message::Err { code: ErrorCode::ProtocolVersion, need: Some(need) }
                );
                extension.closed().await;
            }
        });
    }

    #[test]
    fn the_window_can_be_brought_forward_while_locked_without_a_session() {
        runtime().block_on(async {
            let app = FakeApp::new(VaultState::Locked);
            let mut extension = Extension::connect(&app);
            assert_eq!(extension.next().await, LOCKED);
            extension.send_raw(r#"{"t":"app.show"}"#).await;
            // No answer; the connection stays usable.
            extension.send_raw(r#"{"t":"ping","n":1}"#).await;
            assert_eq!(extension.next().await, Message::Pong { n: 1 });
            assert_eq!(*app.shown.lock().unwrap(), 1);
            extension.send_raw(r#"{"t":"app.show","x":1}"#).await;
            assert_eq!(extension.next().await, refused(ErrorCode::BadFrame));
        });
    }

    #[test]
    fn a_handshake_in_another_version_hears_update_not_unpaired() {
        runtime().block_on(async {
            let app = FakeApp::new(VaultState::Unlocked);
            let (key, public) = noise::generate_keypair();
            app.pair(public);
            for (version, need) in [(PROTOCOL + 1, Need::UpdateApp), (0, Need::UpdateExtension)] {
                let mut extension = Extension::connect(&app);
                extension.next().await;
                let _ = extension.hs1_speaking(&key, &app.public(), version).await;
                assert_eq!(extension.next().await, Message::Err { code: ErrorCode::ProtocolVersion, need: Some(need) });
                extension.closed().await;
            }
        });
    }

    #[test]
    fn a_lock_undone_at_once_still_ends_the_session_and_the_pairing_request() {
        runtime().block_on(async {
            let app = FakeApp::new(VaultState::Unlocked);
            let (key, public) = noise::generate_keypair();
            app.pair(public);
            let mut extension = Extension::connect(&app);
            extension.next().await;
            let mut session = extension.session(&key, &app.public()).await;
            app.lock_and_unlock();
            assert_eq!(extension.receive_x(&mut session).await, r#"{"ev":"locked"}"#);
            assert_eq!(extension.next().await, UNLOCKED);
            // A new session works; the old one is gone.
            let mut fresh = extension.session(&key, &app.public()).await;
            assert_eq!(extension.call(&mut fresh, r#"{"id":1,"m":"ping"}"#).await, r#"{"id":1,"ok":true,"r":{}}"#);

            assert!(matches!(extension.ask_to_pair(&noise::generate_keypair().1, PROTOCOL).await, Message::PairPending { .. }));
            app.lock_and_unlock();
            assert_eq!(extension.receive_x(&mut fresh).await, r#"{"ev":"locked"}"#);
            assert_eq!(extension.next().await, Message::PairResult { approved: false });
            assert_eq!(extension.next().await, UNLOCKED);
            assert_eq!(app.open_dialogs(), 0);
        });
    }

    #[test]
    fn an_answer_given_just_before_a_lock_is_still_delivered() {
        runtime().block_on(async {
            let app = FakeApp::new(VaultState::Unlocked);
            let public = noise::generate_keypair().1;
            let mut extension = Extension::connect(&app);
            extension.next().await;
            assert!(matches!(extension.ask_to_pair(&public, PROTOCOL).await, Message::PairPending { .. }));
            // Approved, then locked, before the connection had a chance to look.
            app.answer(true);
            app.set(VaultState::Locked);
            assert_eq!(extension.next().await, Message::PairResult { approved: true });
            assert_eq!(extension.next().await, LOCKED);
        });
    }

    #[test]
    fn a_revocation_it_cannot_check_ends_the_connection() {
        runtime().block_on(async {
            let app = FakeApp::new(VaultState::Unlocked);
            let (key, public) = noise::generate_keypair();
            let other_public = noise::generate_keypair().1;
            app.pair(public);
            app.pair(other_public);
            let mut extension = Extension::connect(&app);
            extension.next().await;
            let _session = extension.session(&key, &app.public()).await;
            app.broken.store(true, std::sync::atomic::Ordering::SeqCst);
            app.revoke(&other_public);
            // Closed without a word: no "revoked" (it might not be), no session left.
            extension.closed().await;
        });
    }

    #[test]
    fn only_a_paired_browser_holding_this_app_key_gets_a_session() {
        runtime().block_on(async {
            let app = FakeApp::new(VaultState::Unlocked);
            let (key, public) = noise::generate_keypair();

            // Not paired.
            let mut extension = Extension::connect(&app);
            extension.next().await;
            let _ = extension.hs1(&key, &app.public()).await;
            assert_eq!(extension.next().await, refused(ErrorCode::NotPaired));
            extension.closed().await;

            // Paired, but it holds another VaultKey's key (the app's key was made again).
            app.pair(public);
            let mut extension = Extension::connect(&app);
            extension.next().await;
            let _ = extension.hs1(&key, &noise::generate_keypair().1).await;
            assert_eq!(extension.next().await, refused(ErrorCode::NotPaired));
            extension.closed().await;

            // Paired and right, but locked.
            app.set(VaultState::Locked);
            let mut extension = Extension::connect(&app);
            assert_eq!(extension.next().await, LOCKED);
            let _ = extension.hs1(&key, &app.public()).await;
            assert_eq!(extension.next().await, refused(ErrorCode::Locked));
            extension.closed().await;
        });
    }

    #[test]
    fn a_tampered_or_replayed_frame_ends_the_session() {
        runtime().block_on(async {
            let app = FakeApp::new(VaultState::Unlocked);
            let (key, public) = noise::generate_keypair();
            app.pair(public);

            let mut extension = Extension::connect(&app);
            extension.next().await;
            let mut session = extension.session(&key, &app.public()).await;
            let mut sealed = session.encrypt(br#"{"id":1,"m":"ping"}"#).unwrap();
            sealed[3] ^= 0x40;
            extension.send(&Message::X { c: message::encode(&sealed) }).await;
            assert_eq!(extension.next().await, refused(ErrorCode::BadFrame));
            extension.closed().await;

            let mut extension = Extension::connect(&app);
            extension.next().await;
            let mut session = extension.session(&key, &app.public()).await;
            let first = extension.send_x(&mut session, r#"{"id":1,"m":"ping"}"#).await;
            extension.receive_x(&mut session).await;
            extension.send(&Message::X { c: message::encode(&first) }).await;
            assert_eq!(extension.next().await, refused(ErrorCode::BadFrame));
            extension.closed().await;

            // A well-sealed frame that isn't a request.
            let mut extension = Extension::connect(&app);
            extension.next().await;
            let mut session = extension.session(&key, &app.public()).await;
            extension.send_x(&mut session, r#"{"m":"ping"}"#).await;
            assert_eq!(extension.next().await, refused(ErrorCode::BadFrame));
            extension.closed().await;
        });
    }

    #[test]
    fn locking_ends_the_session_and_says_so_inside_it() {
        runtime().block_on(async {
            let app = FakeApp::new(VaultState::Unlocked);
            let (key, public) = noise::generate_keypair();
            app.pair(public);
            let mut extension = Extension::connect(&app);
            extension.next().await;
            let mut session = extension.session(&key, &app.public()).await;

            app.set(VaultState::Locked);
            assert_eq!(extension.receive_x(&mut session).await, r#"{"ev":"locked"}"#);
            assert_eq!(extension.next().await, LOCKED);
            // The session is gone: what was sealed for it is refused.
            extension.send_x(&mut session, r#"{"id":1,"m":"ping"}"#).await;
            assert_eq!(extension.next().await, refused(ErrorCode::BadFrame));
            extension.closed().await;

            // Unlocked again: a new handshake on a new connection.
            app.set(VaultState::Unlocked);
            let mut extension = Extension::connect(&app);
            assert_eq!(extension.next().await, UNLOCKED);
            let mut session = extension.session(&key, &app.public()).await;
            assert_eq!(extension.call(&mut session, r#"{"id":1,"m":"ping"}"#).await, r#"{"id":1,"ok":true,"r":{}}"#);

            // Turning the extension off ends it too, then the connection.
            app.set(VaultState::Disabled);
            assert_eq!(extension.receive_x(&mut session).await, r#"{"ev":"locked"}"#);
            assert_eq!(extension.next().await, DISABLED);
            extension.closed().await;
        });
    }

    #[test]
    fn revoking_ends_only_that_browsers_session() {
        runtime().block_on(async {
            let app = FakeApp::new(VaultState::Unlocked);
            let (key, public) = noise::generate_keypair();
            let (other_key, other_public) = noise::generate_keypair();
            app.pair(public);
            app.pair(other_public);

            let mut extension = Extension::connect(&app);
            extension.next().await;
            let mut session = extension.session(&key, &app.public()).await;
            let mut other = Extension::connect(&app);
            other.next().await;
            let mut other_session = other.session(&other_key, &app.public()).await;

            app.revoke(&public);
            assert_eq!(extension.receive_x(&mut session).await, r#"{"ev":"revoked"}"#);
            let _ = extension.hs1(&key, &app.public()).await;
            assert_eq!(extension.next().await, refused(ErrorCode::NotPaired));
            extension.closed().await;

            // The other browser carries on.
            assert_eq!(other.call(&mut other_session, r#"{"id":5,"m":"ping"}"#).await, r#"{"id":5,"ok":true,"r":{}}"#);
        });
    }

    #[cfg(unix)]
    #[test]
    fn the_socket_is_private_single_owner_and_cleaned_up() {
        use std::os::unix::fs::PermissionsExt;

        runtime().block_on(async {
            let home = tempfile::tempdir().unwrap();
            let directory = home.path().join("vaultkey-dev").join("bridge");
            let path = directory.join("socket");
            // A real socket left behind by a VaultKey that crashed (std doesn't unlink
            // its socket on drop, just as a killed process doesn't).
            std::fs::create_dir_all(&directory).unwrap();
            drop(std::os::unix::net::UnixListener::bind(&path).unwrap());
            assert!(path.exists());

            let address = Address::Socket(path.clone());
            let listener = bind(&address).unwrap();
            let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&directory), 0o700);
            assert_eq!(mode(&path), 0o600);

            // A second VaultKey of the same flavor can't take over.
            assert_eq!(bind(&address).err().unwrap().kind(), io::ErrorKind::AddrInUse);
            assert!(path.exists(), "the refused bind must not remove the live socket");

            drop(listener);
            assert!(!path.exists());
            drop(bind(&address).unwrap());
        });
    }

    #[cfg(unix)]
    #[test]
    fn never_removes_something_that_is_not_a_socket() {
        runtime().block_on(async {
            let home = tempfile::tempdir().unwrap();
            let path = home.path().join("bridge").join("socket");
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, b"someone's notes").unwrap();

            let error = bind(&Address::Socket(path.clone())).err().unwrap();
            assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
            assert_eq!(std::fs::read(&path).unwrap(), b"someone's notes");
        });
    }

    #[cfg(unix)]
    #[test]
    fn serves_over_a_real_socket() {
        runtime().block_on(async {
            let home = tempfile::tempdir().unwrap();
            let address = Address::Socket(home.path().join("bridge").join("socket"));
            let listener = bind(&address).unwrap();
            let server = tokio::spawn(serve(listener, FakeApp::new(VaultState::Unlocked) as Arc<dyn App>));

            let Address::Socket(path) = &address;
            let mut stream = tokio::net::UnixStream::connect(path).await.unwrap();
            assert_eq!(next_on(&mut stream).await, UNLOCKED);
            frame::write_frame(&mut stream, ByteOrder::Little, br#"{"t":"ping","n":42}"#).await.unwrap();
            assert_eq!(next_on(&mut stream).await, Message::Pong { n: 42 });
            server.abort();
        });
    }

    #[cfg(unix)]
    #[test]
    fn turns_away_connections_beyond_the_cap_and_frees_slots() {
        runtime().block_on(async {
            let home = tempfile::tempdir().unwrap();
            let address = Address::Socket(home.path().join("bridge").join("socket"));
            let listener = bind(&address).unwrap();
            let server = tokio::spawn(serve(listener, FakeApp::new(VaultState::Locked) as Arc<dyn App>));
            let Address::Socket(path) = &address;

            let mut open = Vec::new();
            for _ in 0..MAX_CONNECTIONS {
                let mut stream = tokio::net::UnixStream::connect(path).await.unwrap();
                assert!(matches!(next_on(&mut stream).await, Message::State { .. }));
                open.push(stream);
            }

            // One too many: closed without a word.
            let mut extra = tokio::net::UnixStream::connect(path).await.unwrap();
            assert!(matches!(read(&mut extra).await, Ok(None) | Err(_)));

            // Closing one frees its slot (once the server has seen it close).
            drop(open.pop());
            let mut admitted = false;
            for _ in 0..100 {
                let mut stream = tokio::net::UnixStream::connect(path).await.unwrap();
                if let Ok(Some(frame)) = read(&mut stream).await {
                    assert!(matches!(Message::from_bytes(&frame).unwrap(), Message::State { .. }));
                    admitted = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(admitted, "a freed slot is given to the next bridge");
            server.abort();
        });
    }
}
