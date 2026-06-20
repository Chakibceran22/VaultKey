# VaultKey — Design Document

A self-hosted, zero-knowledge password manager. Bitwarden-style architecture: the master password never leaves the client, and vault data is encrypted with AES-GCM before it ever touches the network.

---

## 1. System Overview

VaultKey is a single-user, self-hosted password vault distributed as a desktop application. The user runs both the desktop client and the backend on infrastructure they control (typically the same machine via Docker Compose).

**Repository layout**

```
Password_Manager/
├── app/          Electron + React desktop client
├── backend/      NestJS API + PostgreSQL (via docker-compose)
└── DESIGN.md     (this file)
```

**Stack**

| Layer | Tech |
|---|---|
| Desktop client | Electron 39, React 19, TypeScript, Vite, Tailwind v4, Zustand, TanStack Query |
| Backend API | NestJS, Prisma, JWT (HS256), Helmet, NestJS Throttler |
| Database | PostgreSQL 16 |
| Crypto | Argon2id (master KDF), HKDF-SHA256 (key separation), AES-GCM (vault encryption) |
| Observability | Winston, Loki, Grafana, daily-rotated file logs |
| Packaging | Docker Compose (backend), electron-builder (.deb / .AppImage) |

---

## 2. Architecture

```
┌─────────────────── Desktop (user's machine) ───────────────────┐
│                                                                │
│   ┌── Electron Renderer (React) ────┐                          │
│   │  Login / Signup                 │                          │
│   │  Vault (Domains list)           │                          │
│   │  DomainDetail / Credentials     │                          │
│   │  Argon2id + HKDF + AES-GCM      │ ← ALL crypto here        │
│   └───────────────┬─────────────────┘                          │
│                   │ IPC (window.api)                           │
│   ┌───────────────▼─────────────────┐                          │
│   │  Electron Main (Node)           │                          │
│   │  ipcMain handlers               │                          │
│   │  axios → API_URL                │                          │
│   └───────────────┬─────────────────┘                          │
└───────────────────┼────────────────────────────────────────────┘
                    │ HTTP   (bound to 127.0.0.1 in default deploy)
                    │ Bearer JWT
┌───────────────────▼────────────────────────────────────────────┐
│   Docker Compose stack                                         │
│                                                                │
│   ┌──────────┐  ┌──────────────┐  ┌──────┐   ┌─────────┐       │
│   │ backend  │→ │  postgres    │  │ loki │ ← │ grafana │       │
│   │ NestJS   │  │ vol: pgpass… │  │ logs │   │ UI      │       │
│   └────┬─────┘  └──────────────┘  └──▲───┘   └─────────┘       │
│        │                             │                         │
│        └─── winston-loki ────────────┘                         │
└────────────────────────────────────────────────────────────────┘
```

**Trust boundary.** The desktop client is fully trusted (it sees the master password). The backend is *untrusted* with respect to vault contents — by design, it can only ever see ciphertext for the password field.

---

## 3. Security Model

### 3.1 Threat model

| Threat | Defended? | Mechanism |
|---|---|---|
| Network observer reading vault traffic | Partial | AES-GCM ciphertext for passwords; defaults bind to `127.0.0.1` so traffic doesn't leave the host. HTTPS is the user's responsibility if exposing remotely. |
| Database leak / compromised DB host | Yes (for credential passwords) | Passwords stored only as AES-GCM ciphertext; key is never in DB. |
| Database leak revealing master password | Yes | Server never sees the master password — only the Argon2id+HKDF-derived `authKey`. |
| Stolen `authKey` from DB → vault decryption | Yes | `authKey` and `encryptionKey` are independently derived via HKDF with different `info` strings. Possessing the `authKey` doesn't give you the `encryptionKey`. |
| Stolen `authKey` from DB → impersonation | **No** (known limitation, see §10) | `authKey` is stored as plaintext on the server. A DB leak lets an attacker authenticate to the API. |
| Brute force against master password | Partial | Argon2id (64 MB, 3 iterations, parallelism 1) makes offline cracking expensive *if* the attacker only has the stored `authKey`. The fixed salt is a weakness (see §10). |
| Brute force online | Yes | NestJS Throttler: 5 req/s burst, 100 req/min sustained. |
| Compromised renderer (XSS via vault data) | Partial | Electron `webPreferences.sandbox: false` but renderer is a packaged React app with no remote content loaded. |
| Stolen JWT | Time-bounded | JWT expiry configured via `JWT_EXPIRES_IN`. No refresh-token / revocation. |
| Lost master password | **No recovery** | By design — zero-knowledge means there is no recovery path. |

### 3.2 Crypto pipeline

```
┌────────────────────────────────────────────────────────────┐
│ Client side (renderer/src/lib/crypto.ts)                   │
│                                                            │
│  masterPassword                                            │
│      │                                                     │
│      │ Argon2id                                            │
│      │   salt:  "vaultkey-password-manager"                │
│      │   t=3, m=64 MiB, p=1, 32-byte output                │
│      ▼                                                     │
│  masterKey (32 bytes, never leaves client)                 │
│      │                                                     │
│      ├── HKDF-SHA256(info="vaultkey-auth")  → authKey      │── send to server
│      │                                                       (used for login)
│      └── HKDF-SHA256(info="vaultkey-enc")   → encryptionKey  (kept in RAM
│                                                               via Zustand only;
│                                                               used for AES-GCM)
└────────────────────────────────────────────────────────────┘
```

The HKDF call uses HMAC-SHA256 internally — this is the "HMAC privacy" pattern: a single high-entropy master key feeds an HMAC-based KDF that produces multiple independent sub-keys for distinct purposes. Critically, learning one sub-key does not let you derive the other.

### 3.3 Per-credential encryption

When a credential is created:
1. Renderer encrypts `password` with AES-GCM using `encryptionKey`. A fresh 12-byte IV is generated per encryption.
2. Output format: `base64( IV || ciphertext || GCM-tag )` — IV prepended for self-contained decryption.
3. Only the ciphertext blob is sent to the backend; `username` and `email` are sent in plaintext (see §10).

---

## 4. Backend

### 4.1 Modules

- `AuthModule` — registration, login, JWT issuance.
- `DomainModule` — CRUD on domains (the grouping container for credentials).
- `CredentialModule` — CRUD on credentials.
- `PrismaModule` — DB access.
- Global: `WinstonModule` (console + daily-rotated files + Loki), `ThrottlerModule`, `ConfigModule` with Joi-style schema validation, `Helmet`, `ValidationPipe { whitelist, forbidNonWhitelisted, transform }`, two exception filters (`GlobalExceptionFilter`, `PrismaExceptionFilter`).

### 4.2 Bootstrap

`backend/src/main.ts` wraps `NestFactory.create` in `p-retry` (3 attempts, 3s minimum delay). On all retries exhausted, the process exits with code 1 so the container restart policy (`unless-stopped`) handles supervision.

### 4.3 API surface

All `/domain` and `/credential` routes are guarded by `AuthGuard`, which verifies the `Bearer` JWT.

| Method | Path | Body / Params | Guard | Notes |
|---|---|---|---|---|
| GET    | `/auth/status`                       | —                              | none  | Returns `NEEDS_SIGNUP`, `NEEDS_LOGIN`, or `ERROR` |
| POST   | `/auth/register`                     | `{ authKey }`                  | none  | First-run only (single-user) |
| POST   | `/auth/verify`                       | `{ authKey }`                  | none  | Issues JWT on match |
| POST   | `/domain/register`                   | `{ name }`                     | JWT   | |
| GET    | `/domain/fetch`                      | —                              | JWT   | Returns domains with credential counts |
| DELETE | `/domain/delete/:domainId`           | path                           | JWT   | Cascades to credentials |
| POST   | `/credential/create`                 | `{ username?, email, password, domainId }` | JWT | `password` is AES-GCM ciphertext |
| GET    | `/credential/:domainId`              | path                           | JWT   | Returns ciphertext |
| PUT    | `/credential/update/:credentialId`   | `Partial<{username,email,password}>` | JWT | |
| DELETE | `/credential/delete/:credentialId`   | path                           | JWT   | |

### 4.4 Data model (Prisma)

```prisma
model AuthKey {
  id        Int      @id @default(autoincrement())
  hash      String                    // client-derived authKey (NOT bcrypt'd, see §10)
  createdAt DateTime @default(now())
  updatedAt DateTime @default(now())
}

model Domain {
  id          Int          @id @default(autoincrement())
  name        String       @unique
  credentials Credential[]
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @default(now())
}

model Credential {
  id           Int      @id @default(autoincrement())
  domainId     Int
  username     String?
  email        String                  // plaintext (see §10)
  password     String                  // AES-GCM ciphertext, base64
  createdAt    DateTime @default(now())
  updatedAt   DateTime @default(now())
  lastTimeUsed DateTime @default(now())

  domain Domain @relation(fields: [domainId], references: [id],
                          onDelete: Cascade, onUpdate: Cascade)
  @@unique([email, domainId])
}
```

Single-tenant by design: no `User` table — `AuthKey` is a singleton row.

### 4.5 Observability

- **Console**: human-readable, colorized, includes `context`.
- **File**: `logs/YYYY-MM-DD-error.log`, JSON, 20 MB rotation, 30-day retention.
- **Loki**: `winston-loki` ships logs to `LOKI_URL` with label `app=vaultkey-backend`. Visualized in Grafana.

---

## 5. Desktop Client

### 5.1 Process split

- **Main** (`app/src/main/index.ts`) — Owns the window, all `ipcMain.handle` handlers, and all `axios` calls to the backend. The renderer never makes network calls directly.
- **Preload** (`app/src/preload/index.ts`) — Exposes a typed `window.api` bridge.
- **Renderer** (`app/src/renderer/src/`) — React app. Owns crypto, UI state (Zustand), and server-state caching (TanStack Query).

### 5.2 Renderer state

- `useAuth` (Zustand) — Holds `{ isAuthenticated, token, encryptedKey }`. The `encryptedKey` is the in-memory AES-GCM key derived at login. It lives only in the JS heap of the renderer process — never persisted to disk, never sent over IPC unless to a write/read service that immediately uses it.
- TanStack Query — caches domains and credentials per-domain; invalidates on mutations.

### 5.3 Auth flow

```
Login.tsx                  Auth store              Main (axios)            Backend
   │                           │                       │                      │
   │ enter masterPassword      │                       │                      │
   ├─ deriveKeys() ────────────┤                       │                      │
   │   Argon2id + HKDF         │                       │                      │
   │                           │                       │                      │
   │ login(authKey, encKey)    │                       │                      │
   ├──────────────────────────►│ verifyMaster(authKey) │                      │
   │                           ├──────────────────────►│ POST /auth/verify    │
   │                           │                       ├─────────────────────►│
   │                           │                       │◄──── { token } ──────┤
   │                           │◄──── { token } ───────┤                      │
   │                           │ set { token, encKey } │                      │
   │◄──── ok ──────────────────┤                       │                      │
   │ navigate to /vault        │                       │                      │
```

### 5.4 Credential read path

```
DomainDetail mounts
  → useQuery(['credentials', domainId])
    → credentialsService.getCredentials(token, domainId, encKey)
      → window.api.fetchCredentials(token, domainId)
        → ipcMain → axios GET /credential/:domainId
        ← [{ id, username, email, password: <ciphertext> }]
      ← for each: AES-GCM decrypt(password, encKey)
  → render
```

### 5.5 Configuration

Backend URL is compile-time-injected via Vite `define`. `electron.vite.config.ts` reads `VITE_API_URL` from the app's `.env` and exposes it as the `__API_URL__` global in the main process.

```ts
// app/electron.vite.config.ts
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiUrl = env.VITE_API_URL
  return { main: { define: { __API_URL__: JSON.stringify(apiUrl) } }, ... }
})
```

**`app/.env`:** `VITE_API_URL=http://localhost:13000`

---

## 6. Deployment

### 6.1 Docker Compose

The backend stack runs as a single `docker compose up` from `backend/`. Services:

| Service | Image | Host port | Bind | Notes |
|---|---|---|---|---|
| `postgres` | `postgres:16-alpine` | `${POSTGRES_HOST_PORT:-55432}` | `127.0.0.1` | Volume `pgpasswordata` for persistence |
| `backend` | `vaultkey-backend:latest` | `${BACKEND_HOST_PORT:-13000}` | `127.0.0.1` | Built from `backend/Dockerfile` |
| `loki` | `grafana/loki:2.9.0` | (none) | — | Internal-only |
| `grafana` | `grafana/grafana:latest` | `${GRAFANA_HOST_PORT:-13001}` | `127.0.0.1` | Loki datasource |

**Port strategy:** all host bindings are env-var-driven with high uncommon defaults (`55432`, `13000`, `13001`) to avoid collisions with anything else on the host, and bound to `127.0.0.1` so nothing is exposed beyond loopback. Container-internal ports remain the standard ones (`5432`, `3000`, `3100`) since they're isolated to the compose network.

### 6.2 Backend image

Multi-stage `node:22-alpine`:

1. **Builder stage** — `npm ci`, `npx prisma generate`, `npm run build`.
2. **Production stage** — `npm ci --omit=dev`, copy `dist/` and `generated/`, drop to non-root `appuser`, `CMD npx prisma migrate deploy && node dist/src/main`.

Migrations run as part of container startup, so a fresh DB volume self-initializes.

### 6.3 Backend env

```
DATABASE_URL          postgresql://<user>:<urlencoded-pw>@postgres:5432/password_db
JWT_SECRET            openssl rand -base64 64
JWT_EXPIRES_IN        e.g. "1h"
PORT                  3000 (container-internal)
LOKI_URL              http://loki:3100
POSTGRES_PASSWORD     raw password for the postgres service
POSTGRES_HOST_PORT    55432 (default)
BACKEND_HOST_PORT     13000 (default)
GRAFANA_HOST_PORT     13001 (default)
```

### 6.4 Desktop packaging

`electron-builder` produces `.AppImage` and `.deb` on Linux (`npm run build:linux` from `app/`). The build inlines `VITE_API_URL` at compile time, so each packaged binary is pinned to a specific backend URL.

---

## 7. End-to-End Flows

### 7.1 First-run signup

1. User launches app → main calls `GET /auth/status` → backend returns `NEEDS_SIGNUP` (no row in `AuthKey`).
2. Renderer routes to `/signup`. User enters master password.
3. Renderer runs `deriveKeys(masterPassword)` → `{ authKey, encryptionKey }`.
4. Renderer sends `authKey` only to `POST /auth/register`.
5. Backend writes the single `AuthKey` row.

### 7.2 Login

1. User enters master password → `deriveKeys()` → `{ authKey, encryptionKey }`.
2. `POST /auth/verify` with `authKey`. Server compares against the stored value.
3. On success, server returns JWT signed with `JWT_SECRET`.
4. Renderer stores `{ token, encryptedKey }` in Zustand. `encryptionKey` never leaves the client.

### 7.3 Save a credential

1. UI calls `credentialsService.createCredential(token, encKey, { email, password, domainId })`.
2. `password` is AES-GCM encrypted client-side → base64 blob.
3. IPC → main → `POST /credential/create` with the ciphertext.
4. Backend stores it verbatim.

### 7.4 Read credentials for a domain

1. `useQuery` fires `getCredentials(token, domainId, encKey)`.
2. IPC → main → `GET /credential/:domainId`.
3. Each row's `password` is AES-GCM decrypted client-side using `encKey`.
4. Rendered in the UI; never persisted.

---

## 8. Operational Concerns

- **Restart policy**: all services use `unless-stopped`. The backend additionally uses `p-retry` to weather a slow-starting Postgres.
- **DB health gate**: `postgres` declares a `pg_isready` healthcheck; `backend` `depends_on: { condition: service_healthy }` so it never boots against a half-up DB.
- **Migrations**: `prisma migrate deploy` in the container `CMD` — applied automatically on every container start.
- **Logs**: 30-day file retention + Loki for live queries via Grafana.
- **Rate limiting**: 5/sec burst, 100/min sustained, applied globally via `ThrottlerGuard`.
- **Input validation**: `ValidationPipe { whitelist, forbidNonWhitelisted, transform }` — extra fields rejected, types coerced.
- **HTTP hardening**: `helmet()`.

---

## 9. Project Structure (Detailed)

```
backend/
├── src/
│   ├── main.ts                       p-retry bootstrap
│   ├── app.module.ts                 Winston, Throttler, JWT, Config wiring
│   ├── auth/
│   │   ├── auth.controller.ts        /auth/{status,register,verify}
│   │   ├── auth.service.ts
│   │   ├── guards/auth.guard.ts      JWT Bearer verification
│   │   └── dtos/
│   ├── credential/
│   │   ├── credential.controller.ts  /credential/{create,:id,update,delete}
│   │   ├── credential.service.ts
│   │   └── dtos/
│   ├── domain/
│   │   ├── domain.controller.ts      /domain/{register,fetch,delete}
│   │   ├── domain.service.ts
│   │   └── dtos/
│   ├── prisma/                       PrismaService
│   └── common/
│       ├── config/                   ConfigModule schema (Joi)
│       └── filters/                  Global + Prisma exception filters
├── prisma/schema.prisma
├── Dockerfile                        Multi-stage, non-root
└── docker-compose.yml                postgres + backend (+ loki/grafana)

app/
├── electron.vite.config.ts           Reads VITE_API_URL → __API_URL__
├── src/
│   ├── main/index.ts                 BrowserWindow + ipcMain handlers
│   ├── preload/index.ts              window.api bridge
│   └── renderer/src/
│       ├── App.tsx                   Router
│       ├── pages/                    Login, Signup, Vault, DomainDetail,
│       │                             AddDomain, AddCredential, EditCredential
│       ├── lib/
│       │   ├── crypto.ts             deriveKeys, encrypt, decrypt
│       │   ├── domainsService.ts
│       │   └── credentialsService.ts encrypt-on-write, decrypt-on-read
│       ├── store/
│       │   ├── auth.ts               Zustand: token + encryptionKey
│       │   └── app.ts
│       └── components/ui/            Shadcn-style primitives
└── package.json                      scripts: dev, build, build:linux, …
```

---

## 10. Known Limitations & Future Work

These are the gaps a reader should know about — not bugs to hide.

1. **`authKey` stored in plaintext server-side.** The DB column stores the client-derived `authKey` directly. Best practice (and what Bitwarden does) is to run an additional server-side KDF (e.g. PBKDF2 or Argon2id) before storing. Mitigation: vault contents stay safe even if `authKey` leaks, because the AES-GCM key is independently derived and never sent.
2. **Fixed Argon2 salt.** `ARGON2_SALT = 'vaultkey-password-manager'` is hardcoded. Rainbow-table-style precomputation across many VaultKey users is conceptually possible. For a single-user self-hosted app this is low impact, but a per-install random salt (stored alongside the `AuthKey` row, fetched at login) is the standard fix.
3. **Username/email stored in plaintext.** Only the `password` field is AES-GCM encrypted. A DB leak exposes the user's accounts list (which sites, which usernames). Full E2EE would encrypt these too.
4. **No JWT refresh / revocation.** Token lifetime is fixed by `JWT_EXPIRES_IN`; logout is client-side only.
5. **Single-user only.** No `User` table; `AuthKey` is a singleton. Multi-user would require row-scoping domains and credentials, plus per-user salts.
6. **No vault export / backup / sync.** Backups are the user's responsibility (Postgres `pg_dump` against the host port).
7. **No transport encryption by default.** Defaults bind to `127.0.0.1`. If the user exposes the backend remotely, they must front it with TLS themselves (e.g. Caddy, nginx, Tailscale).
8. **No clipboard auto-clear.** Copied passwords stay in the system clipboard until overwritten.
9. **Unused `app/resources/config.json`.** Holds an old `API_URL` value but nothing reads it. Should be deleted or wired up.
