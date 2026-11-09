export { AuthStatus } from '@renderer/shared/contracts'

export interface CredentialDTO {
  domainId: number
  username?: string
  email: string
  password: string
}
