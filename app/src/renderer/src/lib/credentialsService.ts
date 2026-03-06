import { CredentialDTO } from "@renderer/types"
import { decrypt, encrypt } from "./crypto"

export interface CredentialResponse {
  id: number
  username: string
  email: string
  password: string
}

class CredentialsService {
  async getCredentials(token: string, domainId: number, encryptionKey: string): Promise<CredentialResponse[]> {
    try {
      const response = await window.api.fetchCredentials(token, domainId)
      console.log("Credentials response:", response)

      if ('error' in response) {
        throw new Error('Failed to fetch credentials')
      }
      const credetnials = response.credentials
      const decryptedCredentials = credetnials.map(async (cred) => {
        return {
          ...cred,
          password: await decrypt(cred.password, encryptionKey) 
        }
      })
      return Promise.all(decryptedCredentials)
    } catch (error: any) {
      console.log("Error fetching credentials:", error)
      throw new Error(error.message || 'Failed to fetch credentials')
    }
  }


  async createCredential(token: string,encryptionKey: string, credentialDTO: CredentialDTO) : Promise<boolean> {
    try {
      const encryptedPassword = await encrypt(credentialDTO.password, encryptionKey)
      const response = await window.api.createCredential(token, { ...credentialDTO, password: encryptedPassword })
      if ('error' in response) {
        throw new Error('Failed to create credential')
      }
      return response.success
    } catch (error: any) {
      console.log("Error creating credential:", error)
      throw new Error(error.message || 'Failed to create credential')
    }
  }
}

export const credentialsService = new CredentialsService()
