import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { AccountSummary } from '@renderer/shared/contracts'
import { Spinner } from '@renderer/components/ui/misc'
import { ModalForm } from '@renderer/components/ui/modal-form'
import { Modal } from '@renderer/components/ui/overlays'
import {
  useAccountDetails,
  useAccounts,
  useDomains,
  useLinksState,
  useWebsiteCredentials
} from '@renderer/hooks/use-vault'
import { toast } from '@renderer/lib/toast'
import {
  createAccount,
  emptyAccountDraft,
  updateAccount,
  type AccountDraft
} from '@renderer/lib/vault-actions'
import { AccountFields } from './AccountFields'

/** New account, or edit one, in a modal. */
export function AccountModal({
  open,
  onOpenChange,
  account,
  website = '',
  onSaved
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The account to edit; none to create one. */
  account?: AccountSummary | null
  /** Prefills a new account's website. */
  website?: string
  onSaved?: (accountId: number) => void
}) {
  const { links, isSuccess: linksReady, isError: linksFailed } = useLinksState()
  const { deviceLinks, isSuccess: detailsReady, isError: detailsFailed } = useAccountDetails()
  // Editing needs the current password: decrypt this website only, only while
  // open, and only when there is a password to show.
  const needsPassword = open && !!account?.hasPassword
  const { credentials, isError } = useWebsiteCredentials(needsPassword ? account.domainId : undefined)
  const credential = account ? credentials?.find((c) => c.id === account.id) : undefined

  // The form rewrites the account's links and devices on save, so it only starts
  // once they have loaded: never from an empty list that merely hasn't arrived.
  let initial: AccountDraft | null = null
  if (!account) {
    initial = emptyAccountDraft(website)
  } else if (linksReady && detailsReady && (credential || !account.hasPassword)) {
    const linked = (kind: string): number[] =>
      links.filter((l) => l.accountId === account.id && l.kind === kind).map((l) => l.linkedAccountId)
    const signInWith = linked('sign_in')
    initial = {
      website: account.domainName,
      username: account.username ?? '',
      email: account.email,
      // A saved password comes first: opening as "Another account" would save it as none.
      method: account.hasPassword ? 'password' : signInWith.length ? 'linked' : 'none',
      password: credential?.password ?? '',
      category: account.category ?? '',
      signInWith,
      recoveryBy: linked('recovery'),
      devices: deviceLinks
        .filter((l) => l.accountId === account.id)
        .map((l) => ({ deviceId: l.deviceId, note: l.note }))
    }
  }
  // While closing, keep showing the form that was open (the password is no
  // longer decrypted by then).
  const last = useRef<AccountDraft | null>(null)
  if (initial) last.current = initial
  const shown = initial ?? (open ? null : last.current)
  const failed =
    (needsPassword && (isError || (!!credentials && !credential))) || (!!account && (linksFailed || detailsFailed))

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={account ? `Edit ${account.domainName} account` : 'New account'}
      description={account ? account.email : 'Saved encrypted on this device.'}
    >
      {shown ? (
        <AccountForm
          // A fresh form for each account and each opening.
          key={account ? `edit-${account.id}` : `new-${website}`}
          initial={shown}
          account={account ?? null}
          onCancel={() => onOpenChange(false)}
          onSaved={(id) => {
            onOpenChange(false)
            onSaved?.(id)
          }}
        />
      ) : (
        <div className="flex min-h-40 items-center justify-center text-[13.5px] text-muted-foreground">
          {failed ? 'This account couldn’t be loaded. Close this and try again.' : <Spinner size={20} />}
        </div>
      )}
    </Modal>
  )
}

function AccountForm({
  initial,
  account,
  onCancel,
  onSaved
}: {
  initial: AccountDraft
  account: AccountSummary | null
  onCancel: () => void
  onSaved: (accountId: number) => void
}) {
  const queryClient = useQueryClient()
  const { accounts } = useAccounts()
  const { domains } = useDomains()
  const { devices } = useAccountDetails()
  const [draft, setDraft] = useState(initial)

  return (
    <ModalForm
      submitLabel={account ? 'Save changes' : 'Save account'}
      onCancel={onCancel}
      save={async () => {
        if (account) {
          await updateAccount(queryClient, account, draft)
          toast.success('Account updated')
          onSaved(account.id)
        } else {
          const id = await createAccount(queryClient, domains, draft)
          toast.success('Account saved')
          onSaved(id)
        }
      }}
    >
      <AccountFields
        draft={draft}
        onChange={setDraft}
        showWebsite={!account}
        websites={domains.map((d) => d.name).sort()}
        accounts={accounts}
        devices={devices}
        excludeId={account?.id}
        showCategory
        autoFocus
      />
    </ModalForm>
  )
}
