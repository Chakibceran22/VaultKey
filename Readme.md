# VaultKey

A password vault that lives only on your computer: your accounts and how each one signs
in, the devices they depend on, and your projects' services, secrets and files, all
encrypted in one file on your disk. No account, no server, no sync, no internet.
It runs on macOS, Windows and Linux.

- **Encrypted with a vault key** sealed by your master password (Argon2id, AES-256-GCM).
- **A 24-word recovery code** is the only way back in if you forget your master
  password: nobody else can reset it.
- **Every change is all or nothing**, with verified backups before upgrades.

The app is in [`desktop/`](desktop/) (Tauri 2: a Rust core and a React interface).
How to use it, its security, and how to build and run it on each system:
**[desktop/README.md](desktop/README.md)**.
