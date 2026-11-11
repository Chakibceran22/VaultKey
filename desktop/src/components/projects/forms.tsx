import { useState } from 'react'
import { Eye, EyeSlash, Plus, X } from '@phosphor-icons/react'
import { useQueryClient } from '@tanstack/react-query'
import type { SecretMeta, Service } from '@renderer/shared/contracts'
import { AccountFields } from '@renderer/components/accounts/AccountFields'
import { AccountPicker, Select, Textarea } from '@renderer/components/ui/controls'
import { Button } from '@renderer/components/ui/button'
import { IconButton } from '@renderer/components/ui/icon-button'
import { Field, Input } from '@renderer/components/ui/input'
import { ModalForm } from '@renderer/components/ui/modal-form'
import { hostOf, refreshVault, useAccounts, useDomains } from '@renderer/hooks/use-vault'
import { api } from '@renderer/lib/api'
import { unwrap } from '@renderer/lib/ipc'
import { toast } from '@renderer/lib/toast'
import { emptyAccountDraft, saveService, type LoginDraft, type ServiceDraft } from '@renderer/lib/vault-actions'

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
    accounts: service?.accounts ?? [],
    logins: (service?.logins ?? []).map((l) => ({
      key: `login-${l.id}`,
      id: l.id,
      username: l.username,
      password: '',
      hasPassword: l.hasPassword,
      note: l.note
    })),
    creating: false,
    newAccount: emptyAccountDraft(hostOf(service?.url ?? '')),
    newRole: ''
  }))
  const set = <K extends keyof ServiceDraft>(key: K, value: ServiceDraft[K]): void =>
    setDraft((current) => ({ ...current, [key]: value }))

  return (
    <ModalForm
      submitLabel={service ? 'Save changes' : 'Add service'}
      onCancel={onCancel}
      save={async () => {
        // Once the new account exists, it is one of the chosen ones: a retry must not create it again.
        await saveService(queryClient, domains, projectId, service?.id ?? null, draft, (accountId) =>
          setDraft((current) => ({
            ...current,
            creating: false,
            accounts: [...current.accounts, { accountId, role: current.newRole }],
            newAccount: emptyAccountDraft(hostOf(current.url)),
            newRole: ''
          }))
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
      <Field label="Address" hint="Optional: a URL, hostname or IP">
        {(id) => (
          <Input
            id={id}
            placeholder="https://coolify.acme.dev or 203.0.113.7:22"
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
          <span className="text-[13px] font-medium text-heading">Accounts</span>
          <Button variant="ghost" size="sm" onClick={() => set('creating', !draft.creating)}>
            {draft.creating ? 'Cancel new account' : 'New account'}
          </Button>
        </div>
        <AccountPicker
          accounts={accounts}
          selected={draft.accounts.map((a) => a.accountId)}
          onChange={(ids) =>
            set(
              'accounts',
              ids.map((accountId) => draft.accounts.find((a) => a.accountId === accountId) ?? { accountId, role: '' })
            )
          }
          multiple
          placeholder={draft.accounts.length ? 'Add another account' : 'Search for the accounts this service uses'}
          notes={{
            value: (id) => draft.accounts.find((a) => a.accountId === id)?.role ?? '',
            onChange: (id, role) =>
              set(
                'accounts',
                draft.accounts.map((a) => (a.accountId === id ? { ...a, role } : a))
              ),
            placeholder: 'What it’s for here: admin, deploy only…',
            label: (account) => `What ${account.domainName} is for in this service`
          }}
        />
        {draft.accounts.length === 0 && !draft.creating && (
          <p className="text-[13px] text-muted-foreground">None yet. You can link accounts later.</p>
        )}
      </div>
      {draft.creating && (
        <>
          <AccountFields
            draft={draft.newAccount}
            onChange={(newAccount) => set('newAccount', newAccount)}
            showWebsite
            websites={domains.map((d) => d.name).sort()}
            accounts={accounts}
          />
          <Field label="Role in this service" hint="Optional">
            {(id) => (
              <Input
                id={id}
                placeholder="admin, deploy only…"
                value={draft.newRole}
                maxLength={200}
                onChange={(e) => set('newRole', e.target.value)}
              />
            )}
          </Field>
        </>
      )}
      <LoginsEditor logins={draft.logins} onChange={(logins) => set('logins', logins)} />
    </ModalForm>
  )
}

/**
 * The service's own logins, for what has no account in the vault (a private server's
 * root user, a database user): a username, a password and a note each. A saved
 * password is never shown here; typing a new one replaces it.
 */
function LoginsEditor({ logins, onChange }: { logins: LoginDraft[]; onChange: (logins: LoginDraft[]) => void }) {
  const [shown, setShown] = useState<Set<string>>(new Set())
  const update = (key: string, patch: Partial<LoginDraft>): void =>
    onChange(logins.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  const toggleShown = (key: string): void =>
    setShown((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })
  const add = (): void =>
    onChange([...logins, { key: crypto.randomUUID(), id: null, username: '', password: '', hasPassword: false, note: '' }])

  return (
    <div className="space-y-2.5 border-t pt-5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-medium text-heading">Logins</span>
        <Button variant="ghost" size="sm" onClick={add}>
          <Plus size={12} weight="bold" />
          Add login
        </Button>
      </div>
      {logins.length === 0 && (
        <p className="text-[13px] text-muted-foreground">
          For what has no account in the vault: a server’s root user, a database user.
        </p>
      )}
      {logins.map((login, i) => {
        const which = login.username.trim() || `login ${i + 1}`
        const visible = shown.has(login.key)
        return (
          <div key={login.key} className="frost space-y-2 rounded-lg p-2">
            <div className="flex items-center gap-2">
              <Input
                aria-label={`Username of ${which}`}
                placeholder="Username"
                value={login.username}
                maxLength={200}
                spellCheck={false}
                autoComplete="off"
                autoFocus={login.id === null && !login.username}
                onChange={(e) => update(login.key, { username: e.target.value })}
                className="h-8 min-w-0 flex-1 font-mono text-[13px]"
              />
              <div className="relative min-w-0 flex-1">
                <Input
                  type={visible ? 'text' : 'password'}
                  aria-label={`Password of ${which}`}
                  placeholder={login.hasPassword ? 'Saved' : 'Password'}
                  title={login.hasPassword ? 'Saved. Type a new one to replace it.' : 'Optional: none for an SSH-key-only user'}
                  value={login.password}
                  spellCheck={false}
                  autoComplete="new-password"
                  onChange={(e) => update(login.key, { password: e.target.value })}
                  className="h-8 pr-9 font-mono text-[13px]"
                />
                <IconButton
                  label={visible ? 'Hide password' : 'Show password'}
                  size="icon-sm"
                  className="absolute top-0.5 right-0.5 size-7"
                  onClick={() => toggleShown(login.key)}
                >
                  {visible ? <EyeSlash size={14} /> : <Eye size={14} />}
                </IconButton>
              </div>
              <IconButton label={`Remove ${which}`} size="icon-sm" onClick={() => onChange(logins.filter((l) => l.key !== login.key))}>
                <X size={13} />
              </IconButton>
            </div>
            <Input
              aria-label={`Note for ${which}`}
              placeholder="What it’s for: full access, read-only…"
              value={login.note}
              maxLength={200}
              onChange={(e) => update(login.key, { note: e.target.value })}
              className="h-8 text-[13px]"
            />
          </div>
        )
      })}
    </div>
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
  const [description, setDescription] = useState(secret?.description ?? '')

  return (
    <ModalForm
      submitLabel={secret ? 'Save changes' : 'Add secret'}
      onCancel={onCancel}
      save={async () => {
        const about = description.trim()
        if (secret) {
          unwrap(await api.updateSecret(secret.id, { name, serviceId, description: about, ...(value ? { value } : {}) }))
        } else {
          unwrap(await api.createSecret(projectId, { name, value, serviceId, description: about }))
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
      <Field label="Description" hint="Optional">
        {(id) => (
          <Textarea
            id={id}
            placeholder={isFile ? 'Root SSH key for the prod server' : 'Live mode, read-only, expires in June…'}
            value={description}
            maxLength={2000}
            onChange={(e) => setDescription(e.target.value)}
            className="min-h-16 text-[13.5px]"
          />
        )}
      </Field>
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
          : 'The value and its description are encrypted with your vault key before they are saved.'}
      </p>
    </ModalForm>
  )
}
