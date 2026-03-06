import { CredentialDTO } from "@renderer/types"

export interface CredentialResponse {
  id: number
  username: string
  email: string
  password: string
}

class CredentialsService {
  async getCredentials(token: string, domainId: number): Promise<CredentialResponse[]> {
    try {
      const response = await window.api.fetchCredentials(token, domainId)
      console.log("Credentials response:", response)

      if ('error' in response) {
        throw new Error('Failed to fetch credentials')
      }

      return response.credentials
    } catch (error: any) {
      console.log("Error fetching credentials:", error)
      throw new Error(error.message || 'Failed to fetch credentials')
    }
  }


  async createCredential(token: string, credentialDTO: CredentialDTO) : Promise<boolean> {
    try {
      const response = await window.api.createCredential(token, credentialDTO)
      if ('error' in response) {
        throw new Error('Failed to create credential')
      }
      return response.success
    } catch (error) {
      console.log("Error creating credential:", error)
      throw new Error(error.message || 'Failed to create credential')
    }
  }
}

export const credentialsService = new CredentialsService()
