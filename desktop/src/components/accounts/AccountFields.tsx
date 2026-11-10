import { useState } from 'react'
import { m } from 'framer-motion'
import { ArrowsClockwise } from '@phosphor-icons/react'
import type { AccountSummary, Device } from '@renderer/shared/contracts'
import { StrengthMeter } from '@renderer/components/StrengthMeter'
import { AccountPicker, Segmented, Select } from '@renderer/components/ui/controls'
import { IconButton } from '@renderer/components/ui/icon-button'
import { Field, Input, PasswordInput } from '@renderer/components/ui/input'
import { CATEGORIES, guessCategory } from '@renderer/lib/categories'
import type { AccountDraft } from '@renderer/lib/vault-actions'
import { generatePassword } from '@renderer/lib/password'
import { cn } from '@renderer/lib/utils'
import { DEVICES } from './kinds'

const METHOD_HINT = {
  linked: 'For “Sign in with Google” and the like. No password is stored for this account.',
  none: 'For passkey-only accounts, or ones that only keep keys and notes. Add those on its page.'
} as const

/**
 * The fields of an account, controlled. Used on its own (New / Edit account)
 * and inside "New service" when the service gets an account of its own.
 * `devices` adds the connections only the full form shows: the recovery
 * account and the devices it is signed in on.
 */
export function AccountFields({
  draft,
  onChange,
  showWebsite,
  websites,
  accounts,
  devices,
  excludeId,
  showCategory = false,
  autoFocus = false
}: {
  draft: AccountDraft
  onChange: (draft: AccountDraft) => void
  showWebsite: boolean
  websites: string[]
  accounts: AccountSummary[]
  devices?: Device[]
  /** The account being edited (it can't sign in with itself). */
  excludeId?: number
  /** The group it is shown in on the Accounts page (the full form only). */
  showCategory?: boolean
  autoFocus?: boolean
}) {
  const [revealed, setRevealed] = useState(false)
  const [spins, setSpins] = useState(0)
  const set = <K extends keyof AccountDraft>(key: K, value: AccountDraft[K]): void =>
    onChange({ ...draft, [key]: value })

  return (
    <>
      {showWebsite && (
        <Field label="Website">
          {(id) => (
            <Input
              id={id}
              list="known-websites"
              placeholder="github.com"
              value={draft.website}
              onChange={(e) => set('website', e.target.value)}
              autoFocus={autoFocus && !draft.website}
              required
            />
          )}
        </Field>
      )}
      <Field label="Email">
        {(id) => (
          <Input
            id={id}
            type="email"
            placeholder="you@example.com"
            value={draft.email}
            onChange={(e) => set('email', e.target.value)}
            autoFocus={autoFocus && (!showWebsite || !!draft.website)}
            required
          />
        )}
      </Field>
      <Field label="Username" hint="Optional">
        {(id) => <Input id={id} value={draft.username} onChange={(e) => set('username', e.target.value)} />}
      </Field>
      {showCategory && (
        <Field label="Group" hint="Where it is listed on the Accounts page">
          {(id) => (
            <Select id={id} value={draft.category} onChange={(e) => set('category', e.target.value)}>
              <option value="">
                {draft.website.trim() ? `Automatic: ${guessCategory(draft.website)}` : 'Automatic, from the website'}
              </option>
              {CATEGORIES.map((category) => (
                <option key={category.name} value={category.name}>
                  {category.name}
                </option>
              ))}
              {draft.category && !CATEGORIES.some((c) => c.name === draft.category) && (
                <option value={draft.category}>{draft.category}</option>
              )}
            </Select>
          )}
        </Field>
      )}

      <div className="space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] font-medium text-heading">How it signs in</span>
          <Segmented
            label="How this account signs in"
            value={draft.method}
            onChange={(method) => set('method', method)}
            options={[
              { value: 'password', label: 'Password' },
              { value: 'linked', label: 'Another account' },
              { value: 'none', label: 'No password' }
            ]}
          />
        </div>
        {draft.method === 'password' ? (
          <div className="space-y-2.5">
            <div className="flex gap-2">
              <div className="min-w-0 flex-1">
                <PasswordInput
                  aria-label="Password"
                  placeholder="Enter or generate"
                  value={draft.password}
                  onChange={(e) => set('password', e.target.value)}
                  revealed={revealed}
                  onRevealedChange={setRevealed}
                />
              </div>
              <IconButton
                label="Generate a strong password"
                variant="secondary"
                className="size-10"
                onClick={() => {
                  onChange({ ...draft, password: generatePassword(20) })
                  setRevealed(true)
                  setSpins((count) => count + 1)
                }}
              >
                <m.span className="flex" animate={{ rotate: spins * 180 }} transition={{ type: 'spring', stiffness: 260, damping: 20 }}>
                  <ArrowsClockwise size={16} />
                </m.span>
              </IconButton>
            </div>
            {draft.password && <StrengthMeter password={draft.password} />}
          </div>
        ) : draft.method === 'linked' ? (
          <div className="space-y-1.5">
            <AccountPicker
              accounts={accounts}
              selected={draft.signInWith}
              onChange={(ids) => set('signInWith', ids)}
              multiple
              excludeId={excludeId}
              placeholder="Search for the account it signs in with"
            />
            <p className="text-[12.5px] text-muted-foreground">{METHOD_HINT.linked}</p>
          </div>
        ) : (
          <p className="rounded-lg border border-dashed px-3 py-2.5 text-[12.5px] leading-relaxed text-muted-foreground">
            {METHOD_HINT.none}
          </p>
        )}
      </div>

      {devices && (
        <>
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[13px] font-medium text-heading">Recovery account</span>
              <span className="text-[12px] text-muted-foreground">Optional</span>
            </div>
            <AccountPicker
              accounts={accounts}
              selected={draft.recoveryBy}
              onChange={(ids) => set('recoveryBy', ids)}
              excludeId={excludeId}
              placeholder="The email account that can reset it"
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span id="signed-in-on" className="text-[13px] font-medium text-heading">
                Signed in on
              </span>
              <span className="text-[12px] text-muted-foreground">Optional</span>
            </div>
            {devices.some((d) => d.kind !== 'security_key') ? (
              <div role="group" aria-labelledby="signed-in-on" className="flex flex-wrap gap-1.5">
                {devices
                  .filter((d) => d.kind !== 'security_key' || draft.devices.some((l) => l.deviceId === d.id))
                  .map((device) => {
                  const on = draft.devices.some((l) => l.deviceId === device.id)
                  const DeviceIcon = DEVICES[device.kind].icon
                  return (
                    <button
                      key={device.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        set(
                          'devices',
                          on
                            ? draft.devices.filter((l) => l.deviceId !== device.id)
                            : [...draft.devices, { deviceId: device.id, note: '' }]
                        )
                      }
                      className={cn(
                        'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-[13px] transition-colors duration-150',
                        on
                          ? 'border-primary/40 bg-primary/10 text-heading dark:bg-primary/15'
                          : 'bg-background/50 text-muted-foreground hover:text-foreground dark:bg-white/5'
                      )}
                    >
                      <DeviceIcon size={14} />
                      {device.name}
                    </button>
                  )
                  })}
              </div>
            ) : (
              <p className="text-[12.5px] text-muted-foreground">No devices yet. Add your phone and computers under Devices.</p>
            )}
            {/* What it does on each device it is signed in on (kept encrypted). */}
            {draft.devices.length > 0 && (
              <ul className="space-y-1.5 pt-1">
                {draft.devices.map((link) => {
                  const device = devices.find((d) => d.id === link.deviceId)
                  if (!device) return null
                  const DeviceIcon = DEVICES[device.kind].icon
                  return (
                    <li key={link.deviceId} className="flex items-center gap-2">
                      <span className="flex w-32 shrink-0 items-center gap-1.5 truncate text-[12.5px] text-muted-foreground">
                        <DeviceIcon size={13} className="shrink-0" />
                        <span className="truncate">{device.name}</span>
                      </span>
                      <Input
                        aria-label={`What it does on ${device.name}`}
                        placeholder="What it does there: app, authenticator…"
                        value={link.note}
                        maxLength={200}
                        onChange={(e) =>
                          set(
                            'devices',
                            draft.devices.map((l) => (l.deviceId === link.deviceId ? { ...l, note: e.target.value } : l))
                          )
                        }
                        className="h-8 text-[13px]"
                      />
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </>
      )}

      {showWebsite && (
        <datalist id="known-websites">
          {websites.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      )}
    </>
  )
}
