// IPC contract between the React UI and the Rust core (src-tauri/src/commands.rs).

export enum AuthStatus {
  NEEDS_SIGNUP = 'NEEDS_SIGNUP',
  NEEDS_LOGIN = 'NEEDS_LOGIN'
}

export type VaultErrorCode =
  | 'INVALID_INPUT'
  | 'AUTH_FAILED'
  | 'VAULT_LOCKED'
  | 'ALREADY_EXISTS'
  | 'NOT_FOUND'
  | 'DATABASE_UNAVAILABLE'
  | 'INTERNAL'

export interface VaultError {
  code: VaultErrorCode
  message: string
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: VaultError }

export interface VaultStatusResponse {
  status: AuthStatus
}

export interface DomainRecord {
  id: number
  name: string
  createdAt: string
  updatedAt: string
  _count: {
    credentials: number
  }
}

/** A credential as returned by the Rust core: the password is already decrypted. */
export interface Credential {
  id: number
  username: string | null
  email: string
  password: string
}

/** An account in the vault list: its website and identity, never its password. */
export interface AccountSummary {
  id: number
  domainId: number
  domainName: string
  username: string | null
  email: string
  /** False when saved without a password (signs in with another account, a passkey, or only keeps secrets). */
  hasPassword: boolean
  /** The group chosen for it by hand; null when the app guesses one from the website. */
  category: string | null
  createdAt: string
  updatedAt: string
}

/** `password` is plaintext; the Rust core encrypts it before it touches SQLite. */
export interface CredentialInput {
  domainId: number
  username?: string
  email: string
  password: string
}

export interface CredentialUpdateInput {
  username?: string
  email?: string
  password?: string
}

export interface Project {
  id: number
  name: string
  description: string
  createdAt: string
  updatedAt: string
}

/** An account a service uses, and what it is for there ("admin", "deploy only"). */
export interface ServiceAccount {
  accountId: number
  /** Empty for none. Stored encrypted. */
  role: string
}

/** A service a project uses, signed into with some of the vault's accounts. */
export interface Service {
  id: number
  projectId: number
  name: string
  url: string
  /** In order; the first is the main one. */
  accounts: ServiceAccount[]
  createdAt: string
  updatedAt: string
}

/** A secret or file as listed: never its value. */
export interface SecretMeta {
  id: number
  projectId: number
  serviceId: number | null
  kind: 'text' | 'file'
  name: string
  mimeType: string
  size: number
  /** What it's for, its scopes; empty for none. Stored encrypted. */
  description: string
  createdAt: string
  updatedAt: string
}

export interface Workspace {
  projects: Project[]
  services: Service[]
  secrets: SecretMeta[]
}

/**
 * A directed link between accounts:
 * - sign_in: accountId signs in with linkedAccountId (Vercel → Google)
 * - recovery: linkedAccountId can recover accountId (GitHub → its recovery Gmail)
 */
export type LinkKind = 'sign_in' | 'recovery'

export interface AccountLink {
  accountId: number
  linkedAccountId: number
  kind: LinkKind
}

export type DeviceKind = 'phone' | 'computer' | 'tablet' | 'security_key' | 'other'

/** A phone, computer, tablet or security key that accounts depend on. */
export interface Device {
  id: number
  name: string
  kind: DeviceKind
  notes: string
  createdAt: string
  updatedAt: string
}

export type FactorKind =
  | 'authenticator'
  | 'passkey'
  | 'security_key'
  | 'sms'
  | 'email'
  | 'prompt'
  | 'recovery_codes'

/** A second step or recovery method. `hasSecret`: a setup key or recovery codes are saved (never sent here). */
export interface Factor {
  id: number
  accountId: number
  kind: FactorKind
  label: string
  deviceId: number | null
  hasSecret: boolean
  createdAt: string
  updatedAt: string
}

/** A secret or note kept with an account: never its value. */
export interface AccountSecretMeta {
  id: number
  accountId: number
  kind: 'secret' | 'note'
  name: string
  size: number
  createdAt: string
  updatedAt: string
}

export interface AccountDevice {
  accountId: number
  deviceId: number
  /** What it does there ("mobile app + authenticator"); empty for none. Stored encrypted. */
  note: string
}

/** A device an account is signed in on, as the account form saves it. */
export interface DeviceLinkInput {
  deviceId: number
  note: string
}

export interface AccountDetails {
  devices: Device[]
  factors: Factor[]
  secrets: AccountSecretMeta[]
  /** Devices each account is signed in on. */
  deviceLinks: AccountDevice[]
}

export interface TotpCode {
  code: string
  period: number
  /** Unix time in ms. */
  expiresAt: number
}

export interface DeviceInput {
  name: string
  kind: DeviceKind
  notes?: string
}

export interface FactorInput {
  kind: FactorKind
  label?: string
  deviceId?: number | null
  /** An authenticator's setup key (or otpauth:// link), or the recovery codes. */
  secret?: string
}

export interface FactorUpdateInput {
  label?: string
  deviceId?: number | null
  /** Absent keeps the saved one; empty removes an authenticator's setup key. */
  secret?: string
}

export interface AccountSecretInput {
  kind: 'secret' | 'note'
  name: string
  value: string
}

export interface AccountSecretUpdateInput {
  name: string
  value?: string
}

export interface ProjectInput {
  name: string
  description?: string
}

export interface ServiceInput {
  name: string
  url?: string
  accounts?: ServiceAccount[]
}

export interface SecretInput {
  name: string
  value: string
  serviceId?: number | null
  description?: string
}

export interface SecretUpdateInput {
  name: string
  serviceId?: number | null
  value?: string
  /** Absent keeps the description; empty clears it. */
  description?: string
}

/** A file waiting in the upload dialog: the path stays in Rust, the page gets a token. */
export interface StagedFile {
  token: number
  name: string
  size: number
}

export interface StagedList {
  files: StagedFile[]
  /** Refused just now: a folder, too large, unreadable. */
  skipped: { name: string; reason: string }[]
}

export interface ImportReport {
  imported: number[]
  skipped: { name: string; reason: string }[]
}

export interface VaultApi {
  getVaultStatus: () => Promise<IpcResult<VaultStatusResponse>>
  createVault: (masterPassword: string) => Promise<IpcResult<void>>
  unlockVault: (masterPassword: string) => Promise<IpcResult<{ valid: boolean }>>
  lockVault: () => Promise<IpcResult<void>>
  fetchDomains: () => Promise<IpcResult<{ domains: DomainRecord[] }>>
  registerDomain: (name: string) => Promise<IpcResult<{ id: number }>>
  deleteDomain: (domainId: number) => Promise<IpcResult<void>>
  listAccounts: () => Promise<IpcResult<{ accounts: AccountSummary[] }>>
  fetchCredentials: (domainId: number) => Promise<IpcResult<{ credentials: Credential[] }>>
  createCredential: (input: CredentialInput) => Promise<IpcResult<{ id: number }>>
  deleteCredential: (credentialId: number) => Promise<IpcResult<void>>
  updateCredential: (credentialId: number, input: CredentialUpdateInput) => Promise<IpcResult<void>>
  loadWorkspace: () => Promise<IpcResult<Workspace>>
  createProject: (input: ProjectInput) => Promise<IpcResult<{ id: number }>>
  updateProject: (projectId: number, input: ProjectInput) => Promise<IpcResult<void>>
  deleteProject: (projectId: number) => Promise<IpcResult<void>>
  createService: (projectId: number, input: ServiceInput) => Promise<IpcResult<{ id: number }>>
  updateService: (serviceId: number, input: ServiceInput) => Promise<IpcResult<void>>
  deleteService: (serviceId: number) => Promise<IpcResult<void>>
  createSecret: (projectId: number, input: SecretInput) => Promise<IpcResult<{ id: number }>>
  updateSecret: (secretId: number, input: SecretUpdateInput) => Promise<IpcResult<void>>
  revealSecret: (secretId: number) => Promise<IpcResult<{ value: string }>>
  deleteSecret: (secretId: number) => Promise<IpcResult<void>>
  /** The upload dialog: pick files (native picker), add the last dropped ones, remove one, empty it. */
  stageFiles: () => Promise<IpcResult<StagedList>>
  stageDroppedFiles: () => Promise<IpcResult<StagedList>>
  unstageFile: (token: number) => Promise<IpcResult<StagedList>>
  clearStagedFiles: () => Promise<IpcResult<void>>
  /** Encrypts the chosen files into the project, each with its name (as renamed there) and description. */
  importStagedFiles: (
    projectId: number,
    serviceId: number | null,
    files: { token: number; name: string; description: string }[]
  ) => Promise<IpcResult<ImportReport>>
  exportSecret: (secretId: number) => Promise<IpcResult<{ saved: boolean }>>
  listAccountLinks: () => Promise<IpcResult<{ links: AccountLink[] }>>
  setSignInLinks: (accountId: number, linkedAccountIds: number[]) => Promise<IpcResult<void>>
  setAccountLinks: (accountId: number, kind: LinkKind, linkedAccountIds: number[]) => Promise<IpcResult<void>>
  loadAccountDetails: () => Promise<IpcResult<AccountDetails>>
  createDevice: (input: DeviceInput) => Promise<IpcResult<{ id: number }>>
  updateDevice: (deviceId: number, input: DeviceInput) => Promise<IpcResult<void>>
  deleteDevice: (deviceId: number) => Promise<IpcResult<void>>
  createFactor: (accountId: number, input: FactorInput) => Promise<IpcResult<{ id: number }>>
  updateFactor: (factorId: number, input: FactorUpdateInput) => Promise<IpcResult<void>>
  deleteFactor: (factorId: number) => Promise<IpcResult<void>>
  revealFactor: (factorId: number) => Promise<IpcResult<{ value: string }>>
  factorCode: (factorId: number) => Promise<IpcResult<TotpCode>>
  createAccountSecret: (accountId: number, input: AccountSecretInput) => Promise<IpcResult<{ id: number }>>
  updateAccountSecret: (secretId: number, input: AccountSecretUpdateInput) => Promise<IpcResult<void>>
  revealAccountSecret: (secretId: number) => Promise<IpcResult<{ value: string }>>
  deleteAccountSecret: (secretId: number) => Promise<IpcResult<void>>
  setAccountDevices: (accountId: number, deviceIds: number[]) => Promise<IpcResult<void>>
  /** The group the account is shown in; null goes back to the guessed one. */
  setAccountCategory: (accountId: number, name: string | null) => Promise<IpcResult<void>>
  /** Sign-in links, recovery links and devices, in one transaction. */
  setAccountConnections: (
    accountId: number,
    connections: { signIn: number[]; recovery: number[]; devices: DeviceLinkInput[] }
  ) => Promise<IpcResult<void>>
}
