//! The real `vaultkey-bridge` binary, driven the way a browser drives it (native
//! messaging on stdin/stdout), against the app's server on its own thread, so the test
//! can quit and restart "the app" the way a user would.

// Debug builds only: the bridge honours the test address override there alone.
#![cfg(all(unix, debug_assertions))]

use std::{
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use tokio::{
    io::{AsyncRead, AsyncWrite, AsyncWriteExt},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{oneshot, watch},
};
use vaultkey_bridge::{
    address::{ADDRESS_ENV, Address},
    api,
    frame::{self, ByteOrder},
    message::{self, AppPresence, Browser as BrowserKind, ErrorCode, Message, PROTOCOL, VaultState},
    noise, server,
};

/// The vault behind the server: unlocked, and the user approves every pairing at once.
struct Vault {
    status: watch::Sender<server::Status>,
    key: noise::PrivateKey,
    paired: Mutex<Vec<noise::PublicKey>>,
}

impl Vault {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            status: watch::Sender::new(server::Status { vault: VaultState::Unlocked, pairings: 0, resets: 0 }),
            key: noise::generate_keypair().0,
            paired: Mutex::default(),
        })
    }
}

impl server::App for Vault {
    fn status(&self) -> watch::Receiver<server::Status> {
        self.status.subscribe()
    }

    fn static_key(&self) -> Result<noise::PrivateKey, server::Refusal> {
        Ok(self.key.clone())
    }

    fn client_key(&self, client: &noise::ClientId) -> Result<Option<noise::PublicKey>, server::Refusal> {
        Ok(self.paired.lock().unwrap().iter().copied().find(|key| noise::client_id(key) == *client))
    }

    fn ask_to_pair(&self, request: server::PairingRequest) -> Result<oneshot::Receiver<bool>, server::Refusal> {
        self.paired.lock().unwrap().push(request.public_key);
        let (answer, receiver) = oneshot::channel();
        answer.send(true).unwrap();
        Ok(receiver)
    }

    fn seen(&self, _: &noise::ClientId) {}

    fn accounts(&self) -> Result<Arc<[api::Entry]>, server::Refusal> {
        Ok(Arc::from(vec![api::Entry::new(api::Account {
            id: 1,
            website: "github.com".into(),
            email: "me@x.com".into(),
            username: None,
            has_password: true,
            has_totp: false,
        })]))
    }

    fn login(&self, account: i64) -> Result<Option<api::Login>, server::Refusal> {
        Ok((account == 1).then(|| api::Login { email: "me@x.com".into(), username: None, password: "hunter2".to_owned().into() }))
    }

    fn code(&self, _: i64) -> Result<Option<api::AuthCode>, server::Refusal> {
        Ok(None)
    }

    fn filled(&self, _: api::Fill) {}

    fn open_window(&self) {}
}

/// "VaultKey", on its own runtime. Stopping it drops the runtime and every connection
/// with it, as quitting the app does.
struct App {
    stop: Option<oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl App {
    fn start(socket: PathBuf) -> Self {
        Self::start_with(socket, Vault::new())
    }

    fn start_with(socket: PathBuf, vault: Arc<Vault>) -> Self {
        let (stop, stopped) = oneshot::channel::<()>();
        let (ready, is_ready) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            runtime.block_on(async {
                let listener = server::bind(&Address::Socket(socket)).unwrap();
                ready.send(()).unwrap();
                let serving = tokio::spawn(server::serve(listener, vault));
                let _ = stopped.await;
                serving.abort();
                let _ = serving.await;
            });
        });
        is_ready.recv().unwrap();
        Self { stop: Some(stop), thread: Some(thread) }
    }

    fn quit(mut self) {
        let _ = self.stop.take().unwrap().send(());
        self.thread.take().unwrap().join().unwrap();
    }
}

struct Browser {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: ChildStdout,
}

impl Browser {
    fn start(socket: &std::path::Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_vaultkey-bridge"))
            .arg("chrome-extension://abcdefghijklmnopabcdefghijklmnop/")
            .env(ADDRESS_ENV, socket)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        Self { child, stdin, stdout }
    }

    async fn send(&mut self, json: &str) {
        send_raw(self.stdin.as_mut().unwrap(), json.as_bytes()).await;
    }

    async fn send_message(&mut self, message: &Message) {
        send_raw(self.stdin.as_mut().unwrap(), &message.to_bytes()).await;
    }

    async fn next(&mut self) -> Message {
        next(&mut self.stdout).await
    }

    /// The next `count` messages, in whatever order they arrived.
    async fn next_n(&mut self, count: usize) -> Vec<Message> {
        let mut messages = Vec::new();
        for _ in 0..count {
            messages.push(self.next().await);
        }
        messages
    }
}

async fn send_raw<W: AsyncWrite + Unpin>(writer: &mut W, payload: &[u8]) {
    frame::write_frame(writer, ByteOrder::Native, payload).await.unwrap();
}

async fn next<R: AsyncRead + Unpin>(reader: &mut R) -> Message {
    let frame = tokio::time::timeout(Duration::from_secs(5), frame::read_frame(reader, ByteOrder::Native))
        .await
        .expect("the bridge answered within 5 s")
        .unwrap()
        .expect("the bridge kept stdout open");
    Message::from_bytes(&frame).unwrap()
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
}

const RUNNING: Message = Message::BridgeState { app: AppPresence::Running };
const NOT_RUNNING: Message = Message::BridgeState { app: AppPresence::NotRunning };
const UNLOCKED: Message = Message::State { state: VaultState::Unlocked, protocol: PROTOCOL };

fn same_set(mut got: Vec<Message>, want: &[Message]) {
    let key = |m: &Message| format!("{m:?}");
    got.sort_by_key(key);
    let mut want = want.to_vec();
    want.sort_by_key(key);
    assert_eq!(got, want);
}

#[test]
fn relays_between_the_browser_and_the_app_through_quits_and_restarts() {
    runtime().block_on(async {
        let home = tempfile::tempdir().unwrap();
        let socket = home.path().join("bridge").join("socket");
        let mut browser = Browser::start(&socket);

        // VaultKey isn't open: the bridge says so, for a status and for a frame meant for the app.
        browser.send(r#"{"t":"bridge.status"}"#).await;
        assert_eq!(browser.next().await, NOT_RUNNING);
        browser.send(r#"{"t":"ping","n":1}"#).await;
        assert_eq!(browser.next().await, NOT_RUNNING);

        // VaultKey opens: the next status connects, and the app says the vault's state.
        let app = App::start(socket.clone());
        browser.send(r#"{"t":"bridge.status"}"#).await;
        same_set(browser.next_n(2).await, &[RUNNING, UNLOCKED]);
        browser.send(r#"{"t":"ping","n":2}"#).await;
        assert_eq!(browser.next().await, Message::Pong { n: 2 });

        // The bridge refuses what isn't its own or well formed (objects only), and stays up.
        for refused in [
            r#"{"t":"bridge.launch"}"#,
            r#"{"t":"bridge.status","x":1}"#,
            r#"["bridge.status"]"#,
            r#"["ping",7]"#,
            "not json",
        ] {
            browser.send(refused).await;
            assert_eq!(browser.next().await, Message::Err { code: ErrorCode::BadFrame, need: None }, "{refused}");
        }
        browser.send(r#"{"t":"ping","n":3}"#).await;
        assert_eq!(browser.next().await, Message::Pong { n: 3 });

        // The app refuses what it doesn't know and closes that connection. It is still
        // running, so the bridge reconnects quietly instead of saying it's gone: the
        // extension sees the refusal, then the new connection's state.
        browser.send(r#"{"t":"reveal","h":"x"}"#).await;
        assert_eq!(browser.next().await, Message::Err { code: ErrorCode::BadFrame, need: None });
        assert_eq!(browser.next().await, UNLOCKED);
        browser.send(r#"{"t":"ping","n":4}"#).await;
        assert_eq!(browser.next().await, Message::Pong { n: 4 });

        // VaultKey quits: the bridge notices without being asked.
        app.quit();
        assert_eq!(browser.next().await, NOT_RUNNING);

        // ...and reopens: a frame for the app reconnects by itself.
        let app = App::start(socket.clone());
        browser.send(r#"{"t":"ping","n":5}"#).await;
        same_set(browser.next_n(2).await, &[UNLOCKED, Message::Pong { n: 5 }]);
        browser.send(r#"{"t":"bridge.status"}"#).await;
        assert_eq!(browser.next().await, RUNNING);

        // The browser closes the port: the bridge exits cleanly.
        browser.stdin.take();
        let status = tokio::time::timeout(Duration::from_secs(5), browser.child.wait())
            .await
            .expect("the bridge exited")
            .unwrap();
        assert!(status.success(), "{status:?}");
        app.quit();
    });
}

#[test]
fn a_ping_round_trip_is_fast() {
    runtime().block_on(async {
        let home = tempfile::tempdir().unwrap();
        let socket = home.path().join("bridge").join("socket");
        let app = App::start(socket.clone());
        let mut browser = Browser::start(&socket);
        browser.send(r#"{"t":"bridge.status"}"#).await;
        browser.next_n(2).await;

        let mut times = Vec::new();
        for n in 0..200u32 {
            let started = Instant::now();
            browser.send(&format!(r#"{{"t":"ping","n":{n}}}"#)).await;
            assert_eq!(browser.next().await, Message::Pong { n });
            times.push(started.elapsed());
        }
        times.sort();
        let median = times[times.len() / 2];
        let p95 = times[times.len() * 95 / 100];
        eprintln!("ping round trip through the bridge: median {median:?}, p95 {p95:?}");
        // Generous, so a busy machine doesn't fail it; the real figure is far lower.
        assert!(median < Duration::from_millis(20), "median {median:?}");
        app.quit();
    });
}

#[test]
fn an_oversized_frame_from_the_browser_ends_the_bridge() {
    runtime().block_on(async {
        let home = tempfile::tempdir().unwrap();
        let socket = home.path().join("bridge").join("socket");
        let mut browser = Browser::start(&socket);
        let header = ((frame::MAX_FRAME + 1) as u32).to_ne_bytes();
        let stdin = browser.stdin.as_mut().unwrap();
        stdin.write_all(&header).await.unwrap();
        stdin.flush().await.unwrap();
        let status = tokio::time::timeout(Duration::from_secs(5), browser.child.wait())
            .await
            .expect("the bridge exited")
            .unwrap();
        // A clean exit: a panic (101) or a signal would fail here.
        assert!(status.success(), "{status:?}");
    });
}

#[test]
fn pairs_and_talks_encrypted_through_the_real_bridge() {
    runtime().block_on(async {
        let home = tempfile::tempdir().unwrap();
        let socket = home.path().join("bridge").join("socket");
        let vault = Vault::new();
        let app = App::start_with(socket.clone(), Arc::clone(&vault));
        let app_public = noise::public_key(&vault.key);
        let mut browser = Browser::start(&socket);
        browser.send(r#"{"t":"bridge.status"}"#).await;
        same_set(browser.next_n(2).await, &[RUNNING, UNLOCKED]);

        let (key, public) = noise::generate_keypair();
        browser
            .send_message(&Message::PairRequest {
                public: message::encode(&public),
                name: "Brave on macOS".into(),
                browser: BrowserKind::Brave,
                protocol: PROTOCOL,
            })
            .await;
        assert_eq!(browser.next().await, Message::PairPending { public: message::encode(&app_public) });
        assert_eq!(browser.next().await, Message::PairResult { approved: true });

        let (initiator, hello) = noise::Initiator::start(&key, &app_public).unwrap();
        browser
            .send_message(&Message::Hs1 {
                client: message::encode(&noise::client_id(&public)),
                msg: message::encode(&hello),
                protocol: PROTOCOL,
            })
            .await;
        let Message::Hs2 { msg } = browser.next().await else { panic!("expected hs2") };
        let mut session = initiator.finish(&message::decode(&msg, noise::MAX_HANDSHAKE).unwrap()).unwrap();

        let mut call = async |request: String| -> serde_json::Value {
            let sealed = session.encrypt(request.as_bytes()).unwrap();
            browser.send_message(&Message::X { c: message::encode(&sealed) }).await;
            let Message::X { c } = browser.next().await else { panic!("expected an encrypted reply") };
            let reply = session.decrypt(&message::decode(&c, frame::MAX_FRAME).unwrap()).unwrap();
            serde_json::from_slice(&reply).unwrap()
        };
        for id in 1..=3u32 {
            assert_eq!(call(format!(r#"{{"id":{id},"m":"ping"}}"#)).await, serde_json::json!({ "id": id, "ok": true, "r": {} }));
        }
        // A page's cards, then one login, through the real bridge.
        let page = "https://github.com/login";
        let found = call(format!(r#"{{"id":4,"m":"match","p":{{"tabUrl":"{page}","frameUrl":"{page}"}}}}"#)).await;
        let h = found["r"]["cards"][0]["h"].as_str().unwrap().to_owned();
        let revealed = call(format!(r#"{{"id":5,"m":"reveal","p":{{"h":"{h}","tabUrl":"{page}","frameUrl":"{page}","via":"popup"}}}}"#)).await;
        assert_eq!(revealed["r"]["password"], "hunter2");
        let elsewhere = "https://github.com.evil.io/";
        let refused = call(format!(r#"{{"id":6,"m":"reveal","p":{{"h":"{h}","tabUrl":"{elsewhere}","frameUrl":"{elsewhere}","via":"popup"}}}}"#)).await;
        assert_eq!(refused["e"]["code"], "ORIGIN_MISMATCH");
        app.quit();
    });
}
