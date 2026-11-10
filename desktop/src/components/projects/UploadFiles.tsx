import { useEffect, useState } from 'react'
import { File, UploadSimple, X } from '@phosphor-icons/react'
import { useQueryClient } from '@tanstack/react-query'
import type { Service, StagedFile, StagedList } from '@renderer/shared/contracts'
import { Button } from '@renderer/components/ui/button'
import { Select } from '@renderer/components/ui/controls'
import { IconButton } from '@renderer/components/ui/icon-button'
import { Field, Input } from '@renderer/components/ui/input'
import { ModalForm } from '@renderer/components/ui/modal-form'
import { plural, refreshVault } from '@renderer/hooks/use-vault'
import { api } from '@renderer/lib/api'
import { unwrap } from '@renderer/lib/ipc'
import { toast } from '@renderer/lib/toast'

const size = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

function reportSkipped(list: StagedList): void {
  for (const skipped of list.skipped) toast.error(`${skipped.name}: ${skipped.reason}`)
}

/**
 * The upload dialog: files gathered by drag and drop (onto the window, anywhere) or
 * the native picker, each renamable and with an optional description, then added
 * together. The paths stay in Rust; this page only ever sees a token, a name and a size.
 */
export function UploadFiles({
  projectId,
  services,
  incoming,
  onDone
}: {
  projectId: number
  services: Service[]
  /** Files just dropped onto the window, already staged in Rust. */
  incoming: StagedList | null
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const [files, setFiles] = useState<StagedFile[]>(incoming?.files ?? [])
  const [descriptions, setDescriptions] = useState<Record<number, string>>({})
  const [names, setNames] = useState<Record<number, string>>({})
  const nameOf = (file: StagedFile): string => names[file.token] ?? file.name
  const [serviceId, setServiceId] = useState<number | null>(null)
  const [picking, setPicking] = useState(false)

  // More files dropped while the dialog is open: the list in Rust already has them.
  useEffect(() => {
    if (incoming) setFiles(incoming.files)
  }, [incoming])

  const pick = async (): Promise<void> => {
    setPicking(true)
    try {
      const list = unwrap(await api.stageFiles())
      setFiles(list.files)
      reportSkipped(list)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t open the files')
    } finally {
      setPicking(false)
    }
  }

  const remove = async (token: number): Promise<void> => {
    try {
      setFiles(unwrap(await api.unstageFile(token)).files)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t remove it')
    }
  }

  return (
    <ModalForm
      submitLabel={files.length ? `Add ${plural(files.length, 'file')}` : 'Add files'}
      onCancel={onDone}
      save={async () => {
        if (!files.length) throw new Error('Drop files here or choose them first.')
        if (files.some((f) => !nameOf(f).trim())) throw new Error('Give each file a name.')
        const report = unwrap(
          await api.importStagedFiles(
            projectId,
            serviceId,
            files.map((f) => ({ token: f.token, name: nameOf(f).trim(), description: (descriptions[f.token] ?? '').trim() }))
          )
        )
        await refreshVault(queryClient)
        if (report.imported.length) toast.success(`${plural(report.imported.length, 'file')} added`)
        for (const skipped of report.skipped) toast.error(`${skipped.name}: ${skipped.reason}`)
        onDone()
      }}
    >
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-6 text-center">
        <UploadSimple size={22} className="text-muted-foreground" />
        <p className="text-[13.5px] text-heading">Drop files anywhere on the window</p>
        <p className="text-[12.5px] text-muted-foreground">Up to 25 MB each, encrypted before they are saved.</p>
        <Button size="md" onClick={() => void pick()} disabled={picking}>
          Choose files
        </Button>
      </div>

      {files.length > 0 && (
        <ul className="space-y-2" aria-label="Files to add">
          {files.map((file) => (
            <li key={file.token} className="frost space-y-2 rounded-lg py-2 pr-1.5 pl-2.5">
              <div className="flex items-center gap-2.5">
                <File size={16} className="shrink-0 text-muted-foreground" />
                <Input
                  aria-label={`Name of ${file.name}`}
                  placeholder="File name"
                  value={nameOf(file)}
                  maxLength={200}
                  spellCheck={false}
                  autoComplete="off"
                  // Like Finder: the name is selected without its extension.
                  onFocus={(e) => {
                    const dot = e.target.value.lastIndexOf('.')
                    e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length)
                  }}
                  onChange={(e) => setNames((n) => ({ ...n, [file.token]: e.target.value }))}
                  className="h-8 min-w-0 flex-1 font-mono text-[13px] text-heading"
                />
                <span className="shrink-0 text-[12.5px] text-muted-foreground tabular-nums">{size(file.size)}</span>
                <IconButton label={`Remove ${file.name}`} size="icon-sm" onClick={() => void remove(file.token)}>
                  <X size={13} />
                </IconButton>
              </div>
              <Input
                aria-label={`Description of ${file.name}`}
                placeholder="What it is: root SSH key for prod, .env for staging…"
                value={descriptions[file.token] ?? ''}
                maxLength={2000}
                onChange={(e) => setDescriptions((d) => ({ ...d, [file.token]: e.target.value }))}
                className="ml-6.5 h-8 w-[calc(100%-1.625rem-0.375rem)] text-[13px]"
              />
            </li>
          ))}
        </ul>
      )}

      <Field label="Service" hint="Optional">
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
