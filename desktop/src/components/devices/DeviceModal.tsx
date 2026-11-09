import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Device, DeviceKind } from '@renderer/shared/contracts'
import { DEVICE_KINDS, DEVICES } from '@renderer/components/accounts/kinds'
import { Textarea } from '@renderer/components/ui/controls'
import { Field, Input } from '@renderer/components/ui/input'
import { ModalForm } from '@renderer/components/ui/modal-form'
import { Modal } from '@renderer/components/ui/overlays'
import { refreshVault } from '@renderer/hooks/use-vault'
import { api } from '@renderer/lib/api'
import { unwrap } from '@renderer/lib/ipc'
import { toast } from '@renderer/lib/toast'
import { cn } from '@renderer/lib/utils'

/** A phone, computer, tablet or security key: add one or edit one. */
export function DeviceModal({
  open,
  onOpenChange,
  device,
  onSaved
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  device: Device | null
  onSaved?: (deviceId: number) => void
}) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={device ? `Edit ${device.name}` : 'New device'}
      description={device ? undefined : 'Then link it to the accounts signed in on it, or that use it as a second step.'}
    >
      <DeviceForm
        key={device ? `edit-${device.id}` : 'new'}
        device={device}
        onDone={(id) => {
          onOpenChange(false)
          if (id) onSaved?.(id)
        }}
      />
    </Modal>
  )
}

function DeviceForm({ device, onDone }: { device: Device | null; onDone: (id?: number) => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(device?.name ?? '')
  const [kind, setKind] = useState<DeviceKind>(device?.kind ?? 'phone')
  const [notes, setNotes] = useState(device?.notes ?? '')

  return (
    <ModalForm
      submitLabel={device ? 'Save changes' : 'Add device'}
      onCancel={() => onDone()}
      save={async () => {
        if (!name.trim()) throw new Error('Name the device.')
        const input = { name, kind, notes }
        let id = device?.id
        if (device) unwrap(await api.updateDevice(device.id, input))
        else id = unwrap(await api.createDevice(input)).id
        await refreshVault(queryClient)
        toast.success(device ? 'Device updated' : 'Device added')
        onDone(id)
      }}
    >
      <Field label="Name">
        {(id) => (
          <Input
            id={id}
            placeholder={kind === 'security_key' ? 'YubiKey 5C' : 'iPhone 15'}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            required
          />
        )}
      </Field>
      <div className="space-y-1.5">
        <span id="device-kind" className="text-[13px] font-medium text-heading">
          Kind
        </span>
        <div role="radiogroup" aria-labelledby="device-kind" className="grid grid-cols-5 gap-1.5">
          {DEVICE_KINDS.map((option) => {
            const KindIcon = DEVICES[option].icon
            const checked = option === kind
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={checked}
                onClick={() => setKind(option)}
                className={cn(
                  'flex h-16 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border text-[12px] transition-colors duration-150',
                  checked
                    ? 'border-primary/45 bg-primary/8 font-medium text-heading dark:bg-primary/15'
                    : 'bg-background/40 text-muted-foreground hover:text-foreground dark:bg-white/4'
                )}
              >
                <KindIcon size={18} className={cn(checked && 'text-primary')} />
                {DEVICES[option].name}
              </button>
            )
          })}
        </div>
      </div>
      <Field label="Notes" hint="Not encrypted">
        {(id) => (
          <Textarea
            id={id}
            placeholder="Which SIM, where it is kept… Keep passcodes in an account’s notes, which are encrypted."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="min-h-20"
          />
        )}
      </Field>
    </ModalForm>
  )
}
