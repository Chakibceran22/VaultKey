import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { CheckCircle, DownloadSimple, FolderOpen, FolderSimple, ShieldWarning } from '@phosphor-icons/react'
import type { FilesLayout, SavedFiles, SaveProgress, SecretMeta } from '@renderer/shared/contracts'
import { fileIcon } from '@renderer/components/projects/rows'
import { Button } from '@renderer/components/ui/button'
import { Segmented } from '@renderer/components/ui/controls'
import { Spinner } from '@renderer/components/ui/misc'
import { ModalBody, ModalFooter } from '@renderer/components/ui/overlays'
import { formatSize, plural } from '@renderer/hooks/use-vault'
import { api } from '@renderer/lib/api'
import { IS_MAC } from '@renderer/lib/dom'
import { unwrap } from '@renderer/lib/ipc'
import { cn } from '@renderer/lib/utils'
import { toast } from '@renderer/lib/toast'

type Step =
  | { step: 'ready' }
  /** The native folder picker is open. */
  | { step: 'picking' }
  | { step: 'saving'; progress: SaveProgress }
  | { step: 'saved'; saved: SavedFiles }

const IS_WINDOWS = typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent)
const REVEAL_LABEL = IS_MAC ? 'Show in Finder' : IS_WINDOWS ? 'Show in Explorer' : 'Open folder'

/** The name the new folder will get, as Rust makes it ("Acme files 2026-11-13"). */
function folderName(project: string): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${project} files ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** "/Users/me/Downloads" and "Acme files 2026-11-13" from the new folder's path. */
function splitPath(path: string): { parent: string; name: string } {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut < 0 ? { parent: '', name: path } : { parent: path.slice(0, cut), name: path.slice(cut + 1) }
}

/**
 * The bulk download: what will be saved (and how it will be laid out on disk), then
 * live progress, then where it went. Rust asks for the folder, decrypts one file at a
 * time and keeps nothing unless every file is saved; this page names files by id only.
 */
export function SaveFiles({
  projectId,
  projectName,
  files,
  serviceName,
  onBusyChange,
  onDone
}: {
  projectId: number
  projectName: string
  files: SecretMeta[]
  serviceName: (serviceId: number | null) => string | undefined
  /** True while the folder picker is open or files are being written: not closable. */
  onBusyChange: (busy: boolean) => void
  /** Closes the dialog; `saved` when files were saved. */
  onDone: (saved: boolean) => void
}) {
  const [state, setState] = useState<Step>({ step: 'ready' })
  const [layout, setLayout] = useState<FilesLayout>('flat')
  const [stopping, setStopping] = useState(false)
  const alive = useRef(true)
  const doneRef = useRef<HTMLButtonElement>(null)

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
  const hasServices = files.some((file) => file.serviceId !== null && serviceName(file.serviceId))

  // Progress comes as events while the command runs. The first one (0 done) means the
  // folder was chosen and writing began.
  useEffect(() => {
    let ended = false
    let off: (() => void) | undefined
    listen<SaveProgress>('vault://export-progress', ({ payload }) => {
      setState((current) =>
        current.step === 'picking' || current.step === 'saving' ? { step: 'saving', progress: payload } : current
      )
    }).then(
      (unlisten) => (ended ? unlisten() : (off = unlisten)),
      () => {}
    )
    return () => {
      ended = true
      off?.()
    }
  }, [])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    if (state.step === 'saved') doneRef.current?.focus()
  }, [state.step])

  const start = async (): Promise<void> => {
    setState({ step: 'picking' })
    setStopping(false)
    onBusyChange(true)
    try {
      const saved = unwrap(
        await api.exportFiles(
          projectId,
          files.map((file) => file.id),
          hasServices ? layout : 'flat'
        )
      )
      // Navigated away meanwhile (a swipe back): the save still finished, so say so.
      if (!alive.current) {
        if (saved.status === 'saved') toast.success(`${plural(saved.count, 'file')} saved to “${splitPath(saved.folder).name}”`)
        return
      }
      if (saved.status === 'saved') {
        setState({ step: 'saved', saved })
        return
      }
      if (saved.status === 'cancelled') toast.message('Stopped. Nothing was saved.')
      setState({ step: 'ready' })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t save the files. Nothing was saved.')
      if (alive.current) setState({ step: 'ready' })
    } finally {
      onBusyChange(false)
    }
  }

  const stop = async (): Promise<void> => {
    setStopping(true)
    try {
      unwrap(await api.cancelExport())
    } catch {
      setStopping(false)
    }
  }

  const reveal = async (): Promise<void> => {
    try {
      unwrap(await api.revealExported())
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t open the folder')
    }
  }

  if (state.step === 'saved') {
    const { parent, name } = splitPath(state.saved.folder)
    return (
      <>
        <ModalBody>
          <div className="reveal-in flex flex-col items-center px-2 pt-2 text-center">
            <span className="flex size-11 items-center justify-center rounded-full bg-success/10 text-success">
              <CheckCircle size={24} weight="fill" />
            </span>
            <p className="mt-3 text-[15px] font-medium text-heading">
              {plural(state.saved.count, 'file')} saved
              <span className="font-normal text-muted-foreground"> · {formatSize(state.saved.bytes)}</span>
            </p>
            <div className="frost mt-4 flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left">
              <FolderSimple size={20} weight="duotone" className="shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] font-medium text-heading" data-selectable title={name}>
                  {name}
                </p>
                {parent && (
                  <p className="truncate font-mono text-[11.5px] text-muted-foreground" data-selectable title={state.saved.folder}>
                    {parent}
                  </p>
                )}
              </div>
            </div>
            <p className="mt-3 text-[12.5px] leading-relaxed text-muted-foreground">
              {/* macOS and Linux: saved 0600 in a 0700 folder. Windows: the chosen folder's access. */}
              {IS_WINDOWS ? '' : 'Only your user account can open these copies. '}
              Delete the folder when you no longer need it.
            </p>
          </div>
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" size="lg" onClick={() => void reveal()} className="mr-auto">
            <FolderOpen size={15} />
            {REVEAL_LABEL}
          </Button>
          <Button ref={doneRef} variant="primary" size="lg" onClick={() => onDone(true)}>
            Done
          </Button>
        </ModalFooter>
      </>
    )
  }

  if (state.step === 'saving') {
    const { done, total, bytes } = state.progress
    const share = state.progress.totalBytes > 0 ? bytes / state.progress.totalBytes : total > 0 ? done / total : 0
    const percent = Math.round(Math.min(1, share) * 100)
    return (
      <>
        <ModalBody>
          <div className="space-y-3 py-1" role="status" aria-live="polite">
            <div className="flex items-baseline justify-between gap-4">
              <p className="text-[14px] font-medium text-heading">{stopping ? 'Stopping…' : 'Decrypting and saving…'}</p>
              <p className="shrink-0 text-[12.5px] text-muted-foreground tabular-nums">
                {done} of {total}
              </p>
            </div>
            <div
              role="progressbar"
              aria-label="Saving files"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              className="h-1.5 overflow-hidden rounded-full bg-secondary dark:bg-white/8"
            >
              <div
                className={cn(
                  'h-full rounded-full bg-primary transition-[width] duration-200 ease-smooth motion-reduce:transition-none',
                  stopping && 'bg-muted-foreground/50'
                )}
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="text-[12.5px] leading-relaxed text-muted-foreground tabular-nums">
              {formatSize(bytes)} of {formatSize(state.progress.totalBytes)}. The folder appears once every file is
              saved; stopping keeps nothing.
            </p>
          </div>
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" size="lg" onClick={() => void stop()} disabled={stopping}>
            {stopping && <Spinner size={14} />}
            Stop
          </Button>
        </ModalFooter>
      </>
    )
  }

  // Ready (or the folder picker open): what will be saved, as it will be on disk.
  const picking = state.step === 'picking'
  const grouped = hasServices && layout === 'byService'
  const groups: { name: string | null; files: SecretMeta[] }[] = []
  for (const file of files) {
    const group = grouped ? (serviceName(file.serviceId) ?? null) : null
    const entry = groups.find((g) => g.name === group)
    if (entry) entry.files.push(file)
    else groups.push({ name: group, files: [file] })
  }
  // The whole project's files at the top, as on disk; then each service's folder.
  groups.sort((a, b) => (a.name === null ? -1 : b.name === null ? 1 : a.name.localeCompare(b.name)))

  return (
    <>
      <ModalBody>
        <div className="frost overflow-hidden rounded-xl">
          <div className="flex items-center gap-2.5 border-b px-3.5 py-2.5">
            <FolderSimple size={16} weight="duotone" className="shrink-0 text-primary" />
            <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-heading">{folderName(projectName)}</p>
            <p className="shrink-0 text-[12.5px] text-muted-foreground tabular-nums">
              {plural(files.length, 'file')} · {formatSize(totalBytes)}
            </p>
          </div>
          <ul className="panel-scroll max-h-[13.5rem] overflow-y-auto py-1" aria-label="Files to download">
            {groups.map((group) => (
              <li key={group.name ?? ''}>
                {group.name !== null && (
                  <p className="flex h-8 items-center gap-2 px-3.5 text-[12.5px] font-medium text-foreground">
                    <FolderSimple size={14} className="shrink-0 text-muted-foreground" />
                    <span className="truncate">{group.name}</span>
                  </p>
                )}
                <ul>
                  {group.files.map((file) => {
                    const RowIcon = fileIcon(file)
                    return (
                      <li
                        key={file.id}
                        className={cn('flex h-8 items-center gap-2.5 pr-3.5', group.name !== null ? 'pl-9' : 'pl-3.5')}
                      >
                        <RowIcon size={14} className="shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-heading">{file.name}</span>
                        {!grouped && hasServices && (
                          <span className="max-w-[9rem] shrink-0 truncate text-[12px] text-muted-foreground">
                            {serviceName(file.serviceId) ?? 'Whole project'}
                          </span>
                        )}
                        <span className="w-16 shrink-0 text-right text-[12px] text-muted-foreground tabular-nums">
                          {formatSize(file.size)}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </div>

        {hasServices && (
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[13.5px] font-medium text-heading">Arrange</p>
              <p className="text-[12.5px] text-muted-foreground">
                {grouped ? 'Each service gets a folder; the rest stay at the top.' : 'Same names are kept as “name (2)”.'}
              </p>
            </div>
            <Segmented
              label="Arrange the files"
              value={layout}
              onChange={setLayout}
              options={[
                { value: 'flat', label: 'One folder' },
                { value: 'byService', label: 'By service' }
              ]}
              className="shrink-0"
            />
          </div>
        )}

        <div className="flex gap-3 rounded-xl border border-warning/25 bg-warning/[0.06] px-3.5 py-3 dark:bg-warning/[0.08]">
          <ShieldWarning size={18} weight="duotone" className="mt-px shrink-0 text-warning" />
          <p className="text-[12.5px] leading-relaxed text-foreground">
            <span className="font-medium text-heading">These copies are decrypted.</span> Anyone who can open the folder
            can read them, so keep it somewhere private.
          </p>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" size="lg" onClick={() => onDone(false)} disabled={picking}>
          Cancel
        </Button>
        <Button variant="primary" size="lg" onClick={() => void start()} disabled={picking}>
          {picking ? <Spinner size={14} /> : <DownloadSimple size={15} />}
          {picking ? 'Choose a folder…' : `Download ${plural(files.length, 'file')}…`}
        </Button>
      </ModalFooter>
    </>
  )
}
