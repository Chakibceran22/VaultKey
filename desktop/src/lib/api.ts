import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import type { IpcResult, VaultApi, VaultError } from '@renderer/shared/contracts'

function isVaultError(value: unknown): value is VaultError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as VaultError).code === 'string' &&
    typeof (value as VaultError).message === 'string'
  )
}

/** Calls a Rust command and folds its outcome into the `IpcResult` shape the UI expects. */
async function call<T>(command: string, args?: InvokeArgs): Promise<IpcResult<T>> {
  try {
    return { ok: true, data: await invoke<T>(command, args) }
  } catch (error) {
    if (isVaultError(error)) return { ok: false, error: { code: error.code, message: error.message } }
    // Not a VaultError: Tauri itself rejected the call (bad args, missing permission, …).
    console.error(`[vault] ${command} failed`, error)
    return { ok: false, error: { code: 'INTERNAL', message: 'The local vault is unavailable.' } }
  }
}

export const api: VaultApi = {
  getVaultStatus: () => call('vault_status'),
  createVault: (masterPassword) => call('create_vault', { masterPassword }),
  unlockVault: (masterPassword) => call('unlock_vault', { masterPassword }),
  lockVault: () => call('lock_vault'),
  fetchDomains: () => call('fetch_domains'),
  registerDomain: (name) => call('register_domain', { name }),
  deleteDomain: (domainId) => call('delete_domain', { domainId }),
  listAccounts: () => call('list_accounts'),
  fetchCredentials: (domainId) => call('fetch_credentials', { domainId }),
  createCredential: (input) => call('create_credential', { input }),
  deleteCredential: (credentialId) => call('delete_credential', { credentialId }),
  updateCredential: (credentialId, input) => call('update_credential', { credentialId, input }),
  loadWorkspace: () => call('load_workspace'),
  createProject: (input) => call('create_project', { input }),
  updateProject: (projectId, input) => call('update_project', { projectId, input }),
  deleteProject: (projectId) => call('delete_project', { projectId }),
  createService: (projectId, input) => call('create_service', { projectId, input }),
  updateService: (serviceId, input) => call('update_service', { serviceId, input }),
  deleteService: (serviceId) => call('delete_service', { serviceId }),
  createSecret: (projectId, input) => call('create_secret', { projectId, input }),
  updateSecret: (secretId, input) => call('update_secret', { secretId, input }),
  revealSecret: (secretId) => call('reveal_secret', { secretId }),
  deleteSecret: (secretId) => call('delete_secret', { secretId }),
  stageFiles: () => call('stage_files'),
  stageDroppedFiles: () => call('stage_dropped_files'),
  unstageFile: (token) => call('unstage_file', { token }),
  clearStagedFiles: () => call('clear_staged_files'),
  importStagedFiles: (projectId, serviceId, files) => call('import_staged_files', { projectId, serviceId, files }),
  exportSecret: (secretId) => call('export_secret', { secretId }),
  listAccountLinks: () => call('list_account_links'),
  setSignInLinks: (accountId, linkedAccountIds) => call('set_sign_in_links', { accountId, linkedAccountIds }),
  setAccountLinks: (accountId, kind, linkedAccountIds) =>
    call('set_account_links', { accountId, kind, linkedAccountIds }),
  loadAccountDetails: () => call('load_account_details'),
  createDevice: (input) => call('create_device', { input }),
  updateDevice: (deviceId, input) => call('update_device', { deviceId, input }),
  deleteDevice: (deviceId) => call('delete_device', { deviceId }),
  createFactor: (accountId, input) => call('create_factor', { accountId, input }),
  updateFactor: (factorId, input) => call('update_factor', { factorId, input }),
  deleteFactor: (factorId) => call('delete_factor', { factorId }),
  revealFactor: (factorId) => call('reveal_factor', { factorId }),
  factorCode: (factorId) => call('factor_code', { factorId }),
  createAccountSecret: (accountId, input) => call('create_account_secret', { accountId, input }),
  updateAccountSecret: (secretId, input) => call('update_account_secret', { secretId, input }),
  revealAccountSecret: (secretId) => call('reveal_account_secret', { secretId }),
  deleteAccountSecret: (secretId) => call('delete_account_secret', { secretId }),
  setAccountDevices: (accountId, deviceIds) => call('set_account_devices', { accountId, deviceIds }),
  setAccountCategory: (accountId, name) => call('set_account_category', { accountId, name }),
  setAccountConnections: (accountId, { signIn, recovery, devices }) =>
    call('set_account_connections', { accountId, signIn, recovery, devices })
}
