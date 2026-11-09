import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { AccountSecretMeta, AccountSummary } from '@renderer/shared/contracts'
import { Segmented, Textarea } from '@renderer/components/ui/controls'
import { Field, Input } from '@renderer/components/ui/input'
import { Spinner } from '@renderer/components/ui/misc'
import { ModalForm } from '@renderer/components/ui/modal-form'
import { Modal } from '@renderer/components/ui/overlays'
import { refreshVault } from '@renderer/hooks/use-vault'
import { api } from '@renderer/lib/api'
import { unwrap } from '@renderer/lib/ipc'
import { toast } from '@renderer/lib/toast'

type Kind = AccountSecretMeta['kind']

/** A secret (token, key) or a note kept with an account: add one or edit one. */
export function AccountSecretModal({
  open,
  onOpenChange,
  account,
  secret,
  initialKind = 'secret'
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  account: AccountSummary
  secret: AccountSecretMeta | null
  initialKind?: Kind
}) {
  // Editing shows the current value: decrypted only while this is open.
  // `open` in the key: once closed, the decrypted value has no watcher and is dropped.
  const { data: current, isLoading } = useQuery({
    queryKey: ['account-secret', secret?.id, open],
    queryFn: async () => unwrap(await api.revealAccountSecret(secret!.id)).value,
    enabled: open && !!secret,
    gcTime: 0,
    staleTime: 0
  })
  const kind = secret?.kind ?? initialKind
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={secret ? `Edit ${kind === 'note' ? 'note' : 'secret'}` : 'Add a secret or note'}
      description={`Kept encrypted with ${account.domainName}, ${account.email}`}
    >
      {secret && current === undefined && open ? (
        <div className="flex min-h-40 items-center justify-center text-[13.5px] text-muted-foreground">
          {isLoading ? <Spinner size={20} /> : 'This secret could not be decrypted.'}
        </div>
      ) : (
        <SecretForm
          key={secret ? `edit-${secret.id}` : `new-${initialKind}`}
          account={account}
          secret={secret}
          initial={{ kind, name: secret?.name ?? '', value: current ?? '' }}
          onDone={() => onOpenChange(false)}
        />
      )}
    </Modal>
  )
}

function SecretForm({
  account,
  secret,
  initial,
  onDone
}: {
  account: AccountSummary
  secret: AccountSecretMeta | null
  initial: { kind: Kind; name: string; value: string }
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const [kind, setKind] = useState<Kind>(initial.kind)
  const [name, setName] = useState(initial.name)
  const [value, setValue] = useState(initial.value)
  const note = kind === 'note'

  return (
    <ModalForm
      submitLabel={secret ? 'Save changes' : note ? 'Add note' : 'Add secret'}
      onCancel={onDone}
      save={async () => {
        if (!name.trim()) throw new Error(note ? 'Give the note a title.' : 'Name the secret.')
        if (!value) throw new Error(note ? 'Write the note.' : 'Enter the secret value.')
        if (secret) {
          unwrap(
            await api.updateAccountSecret(secret.id, { name, value: value === initial.value ? undefined : value })
          )
        } else {
          unwrap(await api.createAccountSecret(account.id, { kind, name, value }))
        }
        await refreshVault(queryClient)
        await queryClient.invalidateQueries({ queryKey: ['account-secret'] })
        toast.success(secret ? 'Saved' : note ? 'Note added' : 'Secret added')
        onDone()
      }}
    >
      {!secret && (
        <Segmented
          label="Secret or note"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'secret', label: 'Secret' },
            { value: 'note', label: 'Note' }
          ]}
        />
      )}
      <Field label={note ? 'Title' : 'Name'}>
        {(id) => (
          <Input
            id={id}
            placeholder={note ? 'Security questions, support PIN…' : 'Personal access token, API key…'}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            required
          />
        )}
      </Field>
      <Field label={note ? 'Note' : 'Value'} hint={note ? 'Shown on the account page' : 'Hidden until you show it'}>
        {(id) => (
          <Textarea
            id={id}
            placeholder={note ? 'Anything you’d otherwise have to remember' : 'ghp_…'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className={note ? 'min-h-32' : 'min-h-24 font-mono text-[13px]'}
            required
          />
        )}
      </Field>
    </ModalForm>
  )
}
