import { api } from './api'
import { unwrap } from './ipc'
import type { DomainRecord } from '@renderer/shared/contracts'

class DomainService {
  async getDomains(): Promise<DomainRecord[]> {
    return unwrap(await api.fetchDomains()).domains
  }

  /** Returns the new website's id. */
  async registerDomain(domainName: string): Promise<number> {
    return unwrap(await api.registerDomain(domainName)).id
  }

  async deleteDomain(domainId: number): Promise<boolean> {
    unwrap(await api.deleteDomain(domainId))
    return true
  }
}

export const domainService = new DomainService()
