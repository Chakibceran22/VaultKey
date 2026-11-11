import { useEffect, useMemo, useState } from 'react'
import { Eye, EyeSlash, FileText } from '@phosphor-icons/react'
import { useQueryClient } from '@tanstack/react-query'
import type { EnvEntry, EnvFile, SecretMeta, Service, StagedList } from '@renderer/shared/contracts'
import { Button } from '@renderer/components/ui/button'
import { Select, Textarea } from '@renderer/components/ui/controls'
import { Field, Input } from '@renderer/components/ui/input'
import { ModalForm } from '@renderer/components/ui/modal-form'
import { plural, refreshVault } from '@renderer/hooks/use-vault'
import { api } from '@renderer/lib/api'
import { IS_MAC } from '@renderer/lib/dom'
import { unwrap } from '@renderer/lib/ipc'
import { toast } from '@renderer/lib/toast'
import { cn } from '@renderer/lib/utils'

const mask = (value: string): string => '•'.repeat(Math.min(value.length, 14))
/** One line of a value, for the row: a private key shows its first line. */
const firstLine = (value: string): string => (value.includes('\n') ? `${value.split('\n')[0]} …` : value)

/**
 * The .env import: paste the file, choose it, or drop it onto the window. Each
 * NAME=value line becomes a secret, and the comment on its line its description
 * (editable here). A name the project already has gets its value replaced.
 * Everything chosen is saved together, or nothing is.
 */
export function ImportEnv({
  projectId,
  services,
  secrets,
  incoming,
  onDone
}: {
  projectId: number
  services: Service[]
  /** The project's text secrets: a name already there is replaced, not added again. */
  secrets: SecretMeta[]
  /** A file just dropped onto the window, staged in Rust: read as this .env. */
  incoming: StagedList | null
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const [text, setText] = useState('')
  const [source, setSource] = useState<string | null>(null)
  const [file, setFile] = useState<EnvFile | null>(null)
  /** Names unticked: not imported. */
  const [off, setOff] = useState<Set<string>>(new Set())
  const [descriptions, setDescriptions] = useState<Record<string, string>>({})
  const [serviceId, setServiceId] = useState<number | null>(null)
  const [shown, setShown] = useState(false)
  const [picking, setPicking] = useState(false)

  // Replaced only when exactly one secret has the name: otherwise it's added.
  const replaces = useMemo(() => {
    const byName = new Map<string, SecretMeta[]>()
    for (const secret of secrets) byName.set(secret.name, [...(byName.get(secret.name) ?? []), secret])
    return (name: string): SecretMeta | null => {
      const found = byName.get(name)
      return found?.length === 1 ? found[0] : null
    }
  }, [secrets])
  const descriptionOf = (entry: EnvEntry): string =>
    descriptions[entry.name] ?? (entry.comment || replaces(entry.name)?.description || '')

  // Read as you paste or edit; only the latest answer counts.
  useEffect(() => {
    if (!text.trim()) {
      setFile(null)
      return
    }
    let current = true
    const timer = setTimeout(async () => {
      try {
        const read = unwrap(await api.parseEnv(text))
        if (current) setFile(read)
      } catch (error) {
        if (current) toast.error(error instanceof Error ? error.message : 'Couldn’t read it')
      }
    }, 120)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [text])

  // A file dropped onto the window while this is open: read it here.
  useEffect(() => {
    const dropped = incoming?.files.at(-1)
    if (!dropped) return
    void (async () => {
      try {
        const read = unwrap(await api.readStagedEnv(dropped.token))
        setText(read.text)
        setSource(read.name)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Couldn’t read that file')
      }
    })()
  }, [incoming])

  const pick = async (): Promise<void> => {
    setPicking(true)
    try {
      const read = unwrap(await api.pickEnvFile())
      if (read) {
        setText(read.text)
        setSource(read.name)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t open the file')
    } finally {
      setPicking(false)
    }
  }

  const entries = file?.entries ?? []
  const chosen = entries.filter((entry) => !off.has(entry.name))
  const toggle = (name: string): void =>
    setOff((current) => {
      const next = new Set(current)
      if (!next.delete(name)) next.add(name)
      return next
    })

  return (
    <ModalForm
      submitLabel={chosen.length ? `Import ${plural(chosen.length, 'secret')}` : 'Import'}
      onCancel={onDone}
      save={async () => {
        if (!entries.length) throw new Error('Paste a .env file, choose it, or drop it onto the window first.')
        if (!chosen.length) throw new Error('Tick at least one secret to import.')
        const report = unwrap(
          await api.importEnv(
            projectId,
            serviceId,
            chosen.map((entry) => ({
              name: entry.name,
              value: entry.value,
              description: descriptionOf(entry).trim(),
              replace: replaces(entry.name)?.id ?? null
            }))
          )
        )
        await refreshVault(queryClient)
        const parts = [
          report.added > 0 && `${plural(report.added, 'secret')} added`,
          report.updated > 0 && `${report.updated} updated`
        ].filter(Boolean)
        toast.success(parts.join(', '))
        onDone()
      }}
    >
      <Field label={source ? `From ${source}` : '.env file'} hint="Paste it, choose it, or drop it on the window">
        {(id) => (
          <div className="space-y-2">
            <Textarea
              id={id}
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                setSource(null)
              }}
              placeholder={'STRIPE_SECRET_KEY=sk_live_… # live payments, full access\nDATABASE_URL=postgres://… # production'}
              className="max-h-48 font-mono text-[12.5px]"
            />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Button size="md" onClick={() => void pick()} disabled={picking}>
                <FileText size={14} />
                Choose file
              </Button>
              {IS_MAC && (
                <span className="text-[12px] text-muted-foreground">
                  .env is hidden in the picker: press <kbd className="font-sans">⌘⇧.</kbd> to show it.
                </span>
              )}
            </div>
          </div>
        )}
      </Field>

      {entries.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[12.5px] text-muted-foreground">
              {plural(entries.length, 'secret')} found. The comment on each line is its description.
            </p>
            <Button size="sm" variant="ghost" onClick={() => setShown(!shown)}>
              {shown ? <EyeSlash size={13} /> : <Eye size={13} />}
              {shown ? 'Hide values' : 'Show values'}
            </Button>
          </div>
          <ul className="space-y-2" aria-label="Secrets to import">
            {entries.map((entry) => {
              const included = !off.has(entry.name)
              const replaced = replaces(entry.name)
              return (
                <li key={entry.name} className={cn('frost space-y-2 rounded-lg py-2 pr-2 pl-2.5', !included && 'opacity-55')}>
                  <label className="flex min-w-0 cursor-pointer items-center gap-2.5">
                    <input
                      type="checkbox"
                      checked={included}
                      onChange={() => toggle(entry.name)}
                      className="size-4 shrink-0 cursor-pointer accent-primary"
                    />
                    <span className="min-w-0 truncate font-mono text-[13px] text-heading">{entry.name}</span>
                    {replaced && (
                      <span
                        className="shrink-0 rounded-md border px-1.5 py-px text-[11.5px] text-muted-foreground"
                        title="A secret with this name is already in the project: its value is replaced."
                      >
                        Replaces
                      </span>
                    )}
                    <span
                      className="ml-auto min-w-0 max-w-[45%] truncate font-mono text-[12px] text-muted-foreground"
                      title={shown ? entry.value : undefined}
                    >
                      {shown ? firstLine(entry.value) : mask(entry.value)}
                    </span>
                  </label>
                  {included && (
                    <Input
                      aria-label={`Description of ${entry.name}`}
                      placeholder="What it does: live payments, read-only CI token…"
                      value={descriptionOf(entry)}
                      maxLength={2000}
                      onChange={(e) => setDescriptions((d) => ({ ...d, [entry.name]: e.target.value }))}
                      className="ml-6.5 h-8 w-[calc(100%-1.625rem)] text-[13px]"
                    />
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {file && file.skipped.length > 0 && (
        <div className="space-y-1 text-[12.5px]" aria-label="Lines not imported">
          <p className="text-muted-foreground">Not imported:</p>
          <ul className="space-y-0.5">
            {file.skipped.map((skip) => (
              <li key={`${skip.line}-${skip.reason}`} className="text-muted-foreground">
                <span className="tabular-nums">Line {skip.line}</span>: {skip.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {file && entries.length === 0 && (
        <p className="text-[12.5px] text-muted-foreground">No NAME=value lines found yet.</p>
      )}

      <Field label="Service" hint="Optional, for the new secrets">
        {(id) => (
          <Select id={id} value={serviceId ?? ''} onChange={(e) => setServiceId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Whole project</option>
            {services.map((service) => (
              <option key={service.id} value={service.id}>
                {service.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
    </ModalForm>
  )
}
