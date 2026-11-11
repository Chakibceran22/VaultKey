import { useState } from 'react'
import type { FormEvent } from 'react'
import { StrengthMeter } from '@renderer/components/StrengthMeter'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/controls'
import { Field, PasswordInput } from '@renderer/components/ui/input'
import { Spinner } from '@renderer/components/ui/misc'
import { toast } from '@renderer/lib/toast'
import { useAuth } from '@renderer/store/auth'

const wordsIn = (code: string): number => code.split(/[^a-zA-Z]+/).filter(Boolean).length

/**
 * A forgotten master password: the 24-word recovery code opens the vault key, and a
 * new master password replaces the old one. The vault opens right after, and asks for
 * a new recovery code (this one has now been typed in).
 */
export function RecoverVault({ onBack }: { onBack: () => void }) {
  const recover = useAuth((s) => s.recover)
  const [code, setCode] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const count = wordsIn(code)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (busy) return
    if (count !== 24) return void toast.error(`A recovery code has 24 words; this has ${count}.`)
    if (next.length < 8) return void toast.error('The new master password needs at least 8 characters.')
    if (next !== confirm) return void toast.error('The new passwords don’t match.')
    setBusy(true)
    try {
      await recover(code, next)
      toast.success('Your vault is open with its new master password.')
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : 'The vault couldn’t be recovered.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="w-[min(26rem,calc(100vw-3rem))] space-y-4 text-left">
      <Field label="Recovery code" hint={`${count} of 24 words`}>
        {(id) => (
          <Textarea
            id={id}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="The 24 words you wrote down, in order"
            className="min-h-24 font-mono text-[13px]"
            autoFocus
          />
        )}
      </Field>
      <Field label="New master password" hint="At least 8 characters">
        {(id) => (
          <div className="space-y-2">
            <PasswordInput id={id} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
            {next && <StrengthMeter password={next} />}
          </div>
        )}
      </Field>
      <Field label="Confirm new master password">
        {(id) => <PasswordInput id={id} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />}
      </Field>
      <div className="flex items-center justify-between gap-3 pt-1">
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          Back to unlock
        </Button>
        <Button type="submit" variant="primary" size="lg" disabled={busy}>
          {busy && <Spinner size={14} />}
          Recover vault
        </Button>
      </div>
    </form>
  )
}
