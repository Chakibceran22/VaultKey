import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { AccountSummary, DeviceKind, Factor, FactorKind } from '@renderer/shared/contracts'
import { Button } from '@renderer/components/ui/button'
import { Select, Textarea } from '@renderer/components/ui/controls'
import { Field, Input } from '@renderer/components/ui/input'
import { ModalForm } from '@renderer/components/ui/modal-form'
import { Modal } from '@renderer/components/ui/overlays'
import { refreshVault, useAccountDetails } from '@renderer/hooks/use-vault'
import { api } from '@renderer/lib/api'
import { unwrap } from '@renderer/lib/ipc'
import { toast } from '@renderer/lib/toast'
import { cn } from '@renderer/lib/utils'
import { DEVICE_KINDS, DEVICES, FACTOR_KINDS, FACTORS } from './kinds'

/** A second step or recovery method: add one (choosing its kind) or edit one. */
export function FactorModal({
  open,
  onOpenChange,
  account,
  factor,
  initialKind = 'authenticator'
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  account: AccountSummary
  /** The step to edit; none to add one. */
  factor: Factor | null
  initialKind?: FactorKind
}) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={factor ? `Edit ${FACTORS[factor.kind].name.toLowerCase()}` : 'Add a sign-in step'}
      description={`${account.domainName}, ${account.email}`}
    >
      <FactorForm
        key={factor ? `edit-${factor.id}` : `new-${initialKind}`}
        account={account}
        factor={factor}
        initialKind={initialKind}
        onDone={() => onOpenChange(false)}
      />
    </Modal>
  )
}

type DeviceChoice = number | 'none' | 'new'

function FactorForm({
  account,
  factor,
  initialKind,
  onDone
}: {
  account: AccountSummary
  factor: Factor | null
  initialKind: FactorKind
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const { devices } = useAccountDetails()
  const [kind, setKind] = useState<FactorKind>(factor?.kind ?? initialKind)
  const [label, setLabel] = useState(factor?.label ?? '')
  const [device, setDevice] = useState<DeviceChoice>(factor?.deviceId ?? 'none')
  const [newDevice, setNewDevice] = useState<{ name: string; kind: DeviceKind }>({ name: '', kind: 'phone' })
  const [secret, setSecret] = useState('')
  // Editing: a saved secret is kept unless replaced or removed (never decrypted here).
  const [secretMode, setSecretMode] = useState<'keep' | 'replace' | 'remove'>(
    factor?.hasSecret ? 'keep' : 'replace'
  )
  const meta = FACTORS[kind]

  const chooseKind = (next: FactorKind): void => {
    setKind(next)
    setNewDevice((d) => ({ ...d, kind: next === 'security_key' ? 'security_key' : d.kind === 'security_key' ? 'phone' : d.kind }))
  }

  const save = async (): Promise<void> => {
    let deviceId: number | null = null
    if (meta.device && device === 'new') {
      if (!newDevice.name.trim()) throw new Error('Name the new device.')
      deviceId = unwrap(await api.createDevice({ name: newDevice.name, kind: newDevice.kind })).id
      // A retry after a later failure reuses the device rather than adding it twice.
      setDevice(deviceId)
    } else if (meta.device && typeof device === 'number') {
      deviceId = device
    }

    // Only an explicit Remove deletes a saved secret; a blank replacement keeps it.
    let value: string | undefined
    if (meta.secret !== 'none') {
      if (secretMode === 'remove') value = ''
      else if (secretMode === 'replace' && secret.trim()) value = secret
      else if (meta.secret === 'required' && !factor?.hasSecret) throw new Error('Enter the recovery codes.')
    }

    try {
      if (factor) {
        unwrap(await api.updateFactor(factor.id, { label, deviceId, secret: value }))
      } else {
        unwrap(await api.createFactor(account.id, { kind, label, deviceId, secret: value || undefined }))
      }
    } finally {
      await refreshVault(queryClient)
    }
    toast.success(factor ? `${meta.name} updated` : `${meta.name} added`)
    onDone()
  }

  return (
    <ModalForm submitLabel={factor ? 'Save changes' : `Add ${meta.name.toLowerCase()}`} onCancel={onDone} save={save}>
      {!factor && (
        <div className="space-y-2">
          <div
            role="radiogroup"
            aria-label="Kind of sign-in step"
            className="grid grid-cols-2 gap-1.5"
          >
            {FACTOR_KINDS.map((option) => {
              const OptionIcon = FACTORS[option].icon
              const checked = option === kind
              return (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  onClick={() => chooseKind(option)}
                  className={cn(
                    'flex h-10 cursor-pointer items-center gap-2.5 rounded-lg border px-3 text-left text-[13.5px] transition-colors duration-150',
                    checked
                      ? 'border-primary/45 bg-primary/8 font-medium text-heading dark:bg-primary/15'
                      : 'bg-background/40 text-muted-foreground hover:text-foreground dark:bg-white/4'
                  )}
                >
                  <OptionIcon size={16} className={cn('shrink-0', checked && 'text-primary')} />
                  {FACTORS[option].name}
                </button>
              )
            })}
          </div>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">{meta.about}</p>
        </div>
      )}

      {meta.label && (
        <Field label={meta.label.field} hint="Optional">
          {(id) => (
            <Input
              id={id}
              placeholder={meta.label!.placeholder}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              autoFocus={!!factor}
            />
          )}
        </Field>
      )}

      {meta.device && (
        <div className="space-y-2.5">
          <Field label={meta.device} hint="Optional">
            {(id) => (
              <Select
                id={id}
                value={String(device)}
                onChange={(e) => {
                  const value = e.target.value
                  setDevice(value === 'none' || value === 'new' ? value : Number(value))
                }}
              >
                <option value="none">Not saying</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({DEVICES[d.kind].name.toLowerCase()})
                  </option>
                ))}
                <option value="new">New device…</option>
              </Select>
            )}
          </Field>
          {device === 'new' && (
            <div className="reveal-in grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 rounded-lg border border-dashed p-3">
              <Field label="Device name">
                {(id) => (
                  <Input
                    id={id}
                    placeholder={newDevice.kind === 'security_key' ? 'YubiKey 5C' : 'iPhone 15'}
                    value={newDevice.name}
                    onChange={(e) => setNewDevice({ ...newDevice, name: e.target.value })}
                    autoFocus
                  />
                )}
              </Field>
              <Select
                aria-label="Kind of device"
                value={newDevice.kind}
                onChange={(e) => setNewDevice({ ...newDevice, kind: e.target.value as DeviceKind })}
                className="w-36"
              >
                {DEVICE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {DEVICES[k].name}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>
      )}

      {meta.secret !== 'none' && (
        <SecretField
          kind={kind}
          mode={secretMode}
          onModeChange={setSecretMode}
          value={secret}
          onChange={setSecret}
          editing={!!factor?.hasSecret}
        />
      )}
    </ModalForm>
  )
}

function SecretField({
  kind,
  mode,
  onModeChange,
  value,
  onChange,
  editing
}: {
  kind: FactorKind
  mode: 'keep' | 'replace' | 'remove'
  onModeChange: (mode: 'keep' | 'replace' | 'remove') => void
  value: string
  onChange: (value: string) => void
  /** A secret is already saved. */
  editing: boolean
}) {
  const codes = kind === 'recovery_codes'
  const label = codes ? 'Codes' : 'Setup key'

  if (editing && mode !== 'replace') {
    return (
      <div className="space-y-1.5">
        <span className="text-[13px] font-medium text-heading">{label}</span>
        <div className="flex h-10 items-center gap-2 rounded-lg border bg-background/40 px-3 text-[13.5px] dark:bg-white/4">
          <span className={cn('flex-1', mode === 'remove' ? 'text-destructive' : 'text-muted-foreground')}>
            {mode === 'remove' ? 'Will be removed when you save' : codes ? 'Saved, encrypted' : 'Saved, encrypted. Codes show on the account.'}
          </span>
          {mode === 'remove' ? (
            <Button size="sm" variant="ghost" onClick={() => onModeChange('keep')}>
              Keep it
            </Button>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={() => onModeChange('replace')}>
                Replace
              </Button>
              {!codes && (
                <Button size="sm" variant="destructive-ghost" onClick={() => onModeChange('remove')}>
                  Remove
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <Field label={label} hint={codes ? 'Kept encrypted' : 'Optional'}>
      {(id) =>
        codes ? (
          <Textarea
            id={id}
            placeholder={'One per line, as the site showed them\n4f2a-91bc\n7d0e-3a58'}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="min-h-32 font-mono text-[13px]"
            autoFocus={editing}
          />
        ) : (
          <div className="space-y-1.5">
            <Input
              id={id}
              placeholder="JBSW Y3DP EHPK 3PXP, or an otpauth:// link"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              className="font-mono text-[13px]"
              autoFocus={editing}
            />
            <p className="text-[12.5px] leading-relaxed text-muted-foreground">
              The key shown under “Can’t scan the code?” when you set up the app. With it, the account page shows the
              current code too.
            </p>
          </div>
        )
      }
    </Field>
  )
}

