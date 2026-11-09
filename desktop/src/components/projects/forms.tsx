import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { SecretMeta, Service } from '@renderer/shared/contracts'
import { AccountFields } from '@renderer/components/accounts/AccountFields'
import { AccountPicker, Segmented, Select, Textarea } from '@renderer/components/ui/controls'
import { Field, Input } from '@renderer/components/ui/input'
import { ModalForm } from '@renderer/components/ui/modal-form'
import { hostOf, refreshVault, useAccounts, useDomains } from '@renderer/hooks/use-vault'
import { api } from '@renderer/lib/api'
import { unwrap } from '@renderer/lib/ipc'
import { toast } from '@renderer/lib/toast'
import { emptyAccountDraft, saveService, type ServiceDraft } from '@renderer/lib/vault-actions'

export function ProjectForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: number) => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  return (
    <ModalForm
      submitLabel="Create project"
      onCancel={onCancel}
      save={async () => {
        const { id } = unwrap(await api.createProject({ name, description }))
        await refreshVault(queryClient)
        toast.success('Project created')
        onCreated(id)
      }}
    >
      <Field label="Name">
        {(id) => <Input id={id} placeholder="Acme Store" value={name} onChange={(e) => setName(e.target.value)} autoFocus required />}
      </Field>
      <Field label="Description" hint="Optional">
        {(id) => (
          <Textarea
            id={id}
            placeholder="What it is, where it runs"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="min-h-20"
          />
        )}
      </Field>
    </ModalForm>
  )
}

export function ServiceForm({
  projectId,
  service,
  onCancel,
  onSaved
}: {
  projectId: number
  service: Service | null
  onCancel: () => void
  onSaved: () => void
}) {
  const queryClient = useQueryClient()
  const { accounts } = useAccounts()
  const { domains } = useDomains()
  const [draft, setDraft] = useState<ServiceDraft>(() => ({
    name: service?.name ?? '',
    url: service?.url ?? '',
    access: service ? (service.accountId ? 'existing' : 'none') : 'existing',
    accountId: service?.accountId ?? null,
    newAccount: emptyAccountDraft(hostOf(service?.url ?? ''))
  }))
  const set = <K extends keyof ServiceDraft>(key: K, value: ServiceDraft[K]): void =>
    setDraft((current) => ({ ...current, [key]: value }))

  return (
    <ModalForm
      submitLabel={service ? 'Save changes' : 'Add service'}
      onCancel={onCancel}
      save={async () => {
        await saveService(queryClient, domains, projectId, service?.id ?? null, draft, (accountId) =>
          setDraft((current) => ({ ...current, access: 'existing', accountId }))
        )
        toast.success(service ? 'Service updated' : 'Service added')
        onSaved()
      }}
    >
      <Field label="Name">
        {(id) => (
          <Input id={id} placeholder="Coolify" value={draft.name} onChange={(e) => set('name', e.target.value)} autoFocus required />
        )}
      </Field>
      <Field label="URL" hint="Optional">
        {(id) => (
          <Input
            id={id}
            placeholder="https://coolify.acme.dev"
            value={draft.url}
            onChange={(e) => {
              const url = e.target.value
              setDraft((current) => ({
                ...current,
                url,
                // Keep the new account's website in step with the URL until it's edited.
                newAccount:
                  current.newAccount.website === hostOf(current.url)
                    ? { ...current.newAccount, website: hostOf(url) }
                    : current.newAccount
              }))
            }}
          />
        )}
      </Field>

      <div className="space-y-2.5 border-t pt-5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] font-medium text-heading">Account</span>
          <Segmented
            label="Which account this service uses"
            value={draft.access}
            onChange={(access) => set('access', access)}
            options={[
              { value: 'existing', label: 'From the vault' },
              { value: 'new', label: 'New account' },
              { value: 'none', label: 'None' }
            ]}
          />
        </div>
        {draft.access === 'existing' && (
          <AccountPicker
            accounts={accounts}
            selected={draft.accountId ? [draft.accountId] : []}
            onChange={(ids) => set('accountId', ids[0] ?? null)}
            placeholder="Search for the account this service uses"
          />
        )}
        {draft.access === 'none' && (
          <p className="text-[13px] text-muted-foreground">You can link an account later.</p>
        )}
      </div>
      {draft.access === 'new' && (
        <AccountFields
          draft={draft.newAccount}
          onChange={(newAccount) => set('newAccount', newAccount)}
          showWebsite
          websites={domains.map((d) => d.name).sort()}
          accounts={accounts}
        />
      )}
    </ModalForm>
  )
}

export function SecretForm({
  projectId,
  secret,
  services,
  onCancel,
  onSaved
}: {
  projectId: number
  /** The secret or file to edit; none to add a text secret. */
  secret: SecretMeta | null
  services: Service[]
  onCancel: () => void
  onSaved: () => void
}) {
  const queryClient = useQueryClient()
  const isFile = secret?.kind === 'file'
  const [name, setName] = useState(secret?.name ?? '')
  const [value, setValue] = useState('')
  const [serviceId, setServiceId] = useState<number | null>(secret?.serviceId ?? null)

  return (
    <ModalForm
      submitLabel={secret ? 'Save changes' : 'Add secret'}
      onCancel={onCancel}
      save={async () => {
        if (secret) {
          unwrap(await api.updateSecret(secret.id, { name, serviceId, ...(value ? { value } : {}) }))
        } else {
          unwrap(await api.createSecret(projectId, { name, value, serviceId }))
        }
        await refreshVault(queryClient)
        toast.success(secret ? 'Saved' : 'Secret added')
        onSaved()
      }}
    >
      <Field label="Name">
        {(id) => (
          <Input
            id={id}
            placeholder={isFile ? 'id_ed25519' : 'STRIPE_SECRET_KEY'}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="font-mono text-[13.5px]"
            autoFocus
            required
          />
        )}
      </Field>
      {!isFile && (
        <Field label="Value" hint={secret ? 'Leave empty to keep the current value' : undefined}>
          {(id) => (
            <Textarea
              id={id}
              placeholder={secret ? '••••••••' : 'sk_live_…'}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="font-mono text-[13px]"
              required={!secret}
            />
          )}
        </Field>
      )}
      <Field label="Service" hint="Optional">
        {(id) => (
          <Select
            id={id}
            value={serviceId ?? ''}
            onChange={(e) => setServiceId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Whole project</option>
            {services.map((service) => (
              <option key={service.id} value={service.id}>
                {service.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <p className="text-[12.5px] leading-relaxed text-muted-foreground">
        {isFile
          ? 'The file’s content stays as it is. To replace it, add the new version as a file.'
          : 'Encrypted with your vault key before it is saved.'}
      </p>
    </ModalForm>
  )
}
