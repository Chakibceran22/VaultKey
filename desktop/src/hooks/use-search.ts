import { useMemo } from 'react'
import { DEVICES, FACTORS } from '@renderer/components/accounts/kinds'
import { useAccountDetails, useAccounts, useLinks, useWorkspace } from '@renderer/hooks/use-vault'
import { categoryOf } from '@renderer/lib/categories'
import { buildGraph, type VaultGraph } from '@renderer/lib/search/graph'

/**
 * The vault as a graph, from metadata the app has already loaded: names, kinds
 * and links, never a password, secret value or note body. Rebuilt only when
 * the vault changes.
 */
export function useVaultGraph(): VaultGraph {
  const { accounts } = useAccounts()
  const links = useLinks()
  const { devices, factors, secrets: accountSecrets, deviceLinks } = useAccountDetails()
  const { projects, services, secrets } = useWorkspace()
  return useMemo(
    () =>
      buildGraph({
        accounts,
        links,
        devices,
        factors,
        accountSecrets,
        deviceLinks,
        projects,
        services,
        secrets,
        names: {
          step: (kind) => FACTORS[kind].name,
          device: (kind) => DEVICES[kind].name,
          group: categoryOf
        }
      }),
    [accounts, links, devices, factors, accountSecrets, deviceLinks, projects, services, secrets]
  )
}
