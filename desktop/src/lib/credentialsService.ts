import type { CredentialDTO } from '@renderer/types'
import type { Credential } from '@renderer/shared/contracts'
import { api } from './api'
import { unwrap } from './ipc'

// Encryption and decryption happen in the Rust core; the UI only sees plaintext
// while the vault is unlocked, exactly as before.
export type CredentialResponse = Credential

class CredentialsService {
  async getCredentials(domainId: number): Promise<CredentialResponse[]> {
    return unwrap(await api.fetchCredentials(domainId)).credentials
  }

  /** Returns the new account's id. */
  async createCredential(credentialDTO: CredentialDTO): Promise<number> {
    return unwrap(await api.createCredential(credentialDTO)).id
  }

  async deleteCredential(credentialId: number): Promise<boolean> {
    unwrap(await api.deleteCredential(credentialId))
    return true
  }

  async updateCredential(
    credentialId: number,
    updatedFields: Partial<CredentialDTO>
  ): Promise<boolean> {
    const fields = { ...updatedFields }
    delete fields.domainId
    unwrap(await api.updateCredential(credentialId, fields))
    return true
  }
}

export const credentialsService = new CredentialsService()
