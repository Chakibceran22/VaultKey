import { useState } from 'react'
import { CheckCircle, WarningOctagon } from '@phosphor-icons/react'
import { Button } from '@renderer/components/ui/button'
import { Field, Input, PasswordInput } from '@renderer/components/ui/input'
import { Spinner } from '@renderer/components/ui/misc'
import { ModalForm } from '@renderer/components/ui/modal-form'
import { Modal, ModalBody, ModalFooter } from '@renderer/components/ui/overlays'
import { api } from '@renderer/lib/api'
import { unwrap } from '@renderer/lib/ipc'
import { toast } from '@renderer/lib/toast'

type Step = 'intro' | 'words' | 'confirm' | 'done'

/** Three different positions (from 1) to type back, in order. */
function pickPositions(): number[] {
  const picked = new Set<number>()
  const random = new Uint32Array(1)
  while (picked.size < 3) {
    crypto.getRandomValues(random)
    picked.add((random[0] % 24) + 1)
  }
  return [...picked].sort((a, b) => a - b)
}

/**
 * The recovery code: the only way back into the vault if the master password is
 * forgotten. Shown once (no copy button: it belongs on paper), proven by typing three
 * of its words back with the master password, then saved. `required`: it can't be
 * closed until a code is saved.
 */
export function RecoverySetup({ open, required, onDone }: { open: boolean; required: boolean; onDone: () => void }) {
  return (
    <Modal
      open={open}
      onOpenChange={(next) => !next && !required && onDone()}
      size="lg"
      closable={!required}
      title={required ? 'Save your recovery code' : 'New recovery code'}
      description="The only way back into your vault if you forget your master password."
    >
      {open && <Steps required={required} onDone={onDone} />}
    </Modal>
  )
}

function Warning() {
  return (
    <div className="flex gap-3 rounded-xl border border-destructive/40 bg-destructive/8 px-4 py-3.5 text-[13.5px] leading-relaxed">
      <WarningOctagon size={22} weight="fill" className="mt-0.5 shrink-0 text-destructive" />
      <div className="space-y-1.5">
        <p className="font-medium text-heading">Never lose this code.</p>
        <p className="text-foreground/90">
          Nobody can reset your master password for you: not VaultKey, not support, not by email. If you forget your
          master password <strong>and</strong> lose this code, everything in your vault is gone for good.
        </p>
        <p className="text-foreground/90">
          Write the 24 words on paper, in order, and keep it somewhere safe, away from this computer. Never keep it in
          this vault, in email, notes or the cloud: anyone with these words and your vault file can open your vault.
        </p>
      </div>
    </div>
  )
}

function Steps({ required, onDone }: { required: boolean; onDone: () => void }) {
  const [step, setStep] = useState<Step>('intro')
  const [words, setWords] = useState<string[]>([])
  const [written, setWritten] = useState(false)
  const [positions] = useState(pickPositions)
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  if (step === 'intro') {
    const show = async (): Promise<void> => {
      setLoading(true)
      try {
        setWords(unwrap(await api.newRecoveryCode()).words)
        setStep('words')
      } catch (error) {
        toast.error(error instanceof Error && error.message ? error.message : 'Couldn’t create a recovery code.')
      } finally {
        setLoading(false)
      }
    }
    return (
      <>
        <ModalBody>
          <Warning />
          <p className="text-[13.5px] leading-relaxed text-muted-foreground">
            Your recovery code is 24 random words. It can set a new master password, and nothing else can. It’s shown
            only once, so have paper and a pen ready.
          </p>
        </ModalBody>
        <ModalFooter>
          {!required && (
            <Button variant="ghost" onClick={onDone}>
              Cancel
            </Button>
          )}
          <Button variant="primary" onClick={() => void show()} disabled={loading}>
            {loading && <Spinner size={14} />}
            Show my recovery code
          </Button>
        </ModalFooter>
      </>
    )
  }

  if (step === 'words') {
    return (
      <>
        <ModalBody>
          <ol className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-xl border bg-secondary/30 px-5 py-4 sm:grid-cols-3 md:grid-cols-4">
            {words.map((word, i) => (
              <li key={i} className="flex items-baseline gap-2 font-mono text-[14px] select-none">
                <span className="w-5 text-right text-[11.5px] text-muted-foreground tabular-nums">{i + 1}</span>
                <span className="text-heading">{word}</span>
              </li>
            ))}
          </ol>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            Shown only now. Write all 24 words down, in this order. Each word is known by its first four letters.
          </p>
          <label className="flex cursor-pointer items-start gap-2.5 text-[13.5px] text-heading">
            <input
              type="checkbox"
              checked={written}
              onChange={(e) => setWritten(e.target.checked)}
              className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary"
            />
            I’ve written all 24 words down, in order, and I’ll keep them somewhere safe.
          </label>
        </ModalBody>
        <ModalFooter>
          <Button variant="primary" onClick={() => setStep('confirm')} disabled={!written}>
            Continue
          </Button>
        </ModalFooter>
      </>
    )
  }

  if (step === 'confirm') {
    return (
      <ModalForm
        submitLabel="Save recovery code"
        onCancel={() => setStep('words')}
        save={async () => {
          if (positions.some((p) => !answers[p]?.trim())) throw new Error('Type the three words asked for.')
          if (!password) throw new Error('Enter your master password.')
          unwrap(
            await api.saveRecoveryCode(
              password,
              positions.map((position) => ({ position, word: answers[position] }))
            )
          )
          setWords([])
          setPassword('')
          setStep('done')
        }}
      >
        <p className="text-[13.5px] leading-relaxed text-muted-foreground">
          From what you wrote down, type these words. Then your master password, so only you can set a recovery code.
        </p>
        <div className="grid grid-cols-3 gap-3">
          {positions.map((position) => (
            <Field key={position} label={`Word ${position}`}>
              {(id) => (
                <Input
                  id={id}
                  value={answers[position] ?? ''}
                  onChange={(e) => setAnswers((a) => ({ ...a, [position]: e.target.value }))}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  autoFocus={position === positions[0]}
                />
              )}
            </Field>
          ))}
        </div>
        <Field label="Master password">
          {(id) => <PasswordInput id={id} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />}
        </Field>
      </ModalForm>
    )
  }

  return (
    <>
      <ModalBody>
        <div className="flex items-start gap-3 text-[13.5px] leading-relaxed">
          <CheckCircle size={22} weight="fill" className="mt-0.5 shrink-0 text-primary" />
          <div className="space-y-1.5">
            <p className="text-heading">Your recovery code is saved.</p>
            <p className="text-muted-foreground">
              If you ever forget your master password, choose “Forgot your master password?” on the lock screen and type
              these 24 words. Making a new code later replaces this one.
            </p>
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
      </ModalFooter>
    </>
  )
}
