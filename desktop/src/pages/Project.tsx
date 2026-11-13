import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { DownloadSimple, FileArrowUp, FilePlus, Plus, Trash } from '@phosphor-icons/react'
import { useQueryClient } from '@tanstack/react-query'
import type { AccountSummary, SecretMeta, Service, StagedList } from '@renderer/shared/contracts'
import { RelatedGroup } from '@renderer/components/accounts/parts'
import {
  EmptyFrame,
  EmptyLine,
  History,
  ListFrame,
  Page,
  PageHeader,
  RecordColumns,
  Section,
  useShowSection
} from '@renderer/components/layout/page'
import { SecretRow, ServiceRow, type ServiceAccountView } from '@renderer/components/projects/rows'
import { SecretForm, ServiceForm } from '@renderer/components/projects/forms'
import { UploadFiles } from '@renderer/components/projects/UploadFiles'
import { SaveFiles } from '@renderer/components/projects/SaveFiles'
import { ImportEnv } from '@renderer/components/projects/ImportEnv'
import { ListFilter, listFooter, MoreLine, NoMatchLine, useLongList, useSlashToFilter } from '@renderer/components/layout/long-list'
import { Button } from '@renderer/components/ui/button'
import { useConfirm } from '@renderer/components/ui/confirm'
import { InlineEdit } from '@renderer/components/ui/controls'
import { Spinner } from '@renderer/components/ui/misc'
import { Modal, RowMenu, RowMenuItem } from '@renderer/components/ui/overlays'
import { formatSize, hostOf, plural, refreshVault, useAccounts, useRelations, useWorkspace } from '@renderer/hooks/use-vault'
import { api } from '@renderer/lib/api'
import { isModKey, isOverlayOpen, isTyping, MOD } from '@renderer/lib/dom'
import { useDropTarget } from '@renderer/lib/drop-target'
import { unwrap } from '@renderer/lib/ipc'
import { toast } from '@renderer/lib/toast'

type ModalState =
  | { open: boolean; kind: 'service'; service: Service | null }
  | { open: boolean; kind: 'secret'; secret: SecretMeta | null }
  | { open: boolean; kind: 'upload'; incoming: StagedList | null }
  | { open: boolean; kind: 'env'; incoming: StagedList | null }
  | { open: boolean; kind: 'download'; files: SecretMeta[] }

/**
 * Pattern: Detail / Record. One project: name and description edited in place,
 * then its services, secrets and files, each a section with its own action;
 * beside them, the accounts it depends on. Adding and editing happen in a modal.
 */
export default function ProjectPage(): React.ReactElement {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { projectId: rawId } = useParams()
  const projectId = Number(rawId)
  const { projects, services, secrets, isLoading } = useWorkspace()
  const { accounts } = useAccounts()
  const relationsOf = useRelations()
  const { confirm, dialog } = useConfirm()
  const setDropTarget = useDropTarget((s) => s.setTarget)
  const dropped = useDropTarget((s) => s.dropped)
  const setDropped = useDropTarget((s) => s.setDropped)
  const [modal, setModal] = useState<ModalState>({ open: false, kind: 'service', service: null })
  const [openService, setOpenService] = useState<number | null>(null)
  // Files chosen to download together, and the last one toggled (where a shift-click
  // range starts). Ids only: a file deleted meanwhile simply drops out.
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set())
  const anchor = useRef<number | null>(null)
  // The download dialog is choosing a folder or writing: it can't be closed then.
  const [downloading, setDownloading] = useState(false)

  const project = projects.find((p) => p.id === projectId)
  const projectServices = services.filter((s) => s.projectId === projectId)
  const textSecrets = secrets.filter((s) => s.projectId === projectId && s.kind === 'text')
  const files = secrets.filter((s) => s.projectId === projectId && s.kind === 'file')
  const serviceName = (id: number | null): string | undefined => projectServices.find((s) => s.id === id)?.name

  // Each list stays short however long it gets: the first few, a filter, "Show all".
  const serviceList = useLongList(projectServices, (service) =>
    [
      service.name,
      hostOf(service.url),
      ...service.accounts.flatMap(({ accountId, role }) => {
        const account = accounts.find((a) => a.id === accountId)
        return account ? [account.domainName, account.email, account.username ?? '', role] : [role]
      })
    ].join(' ')
  )
  const kept = (secret: SecretMeta): string =>
    [secret.name, secret.description, serviceName(secret.serviceId) ?? 'whole project'].join(' ')
  const secretList = useLongList(textSecrets, kept)
  const fileList = useLongList(files, kept)
  useSlashToFilter()

  const selectedFiles = files.filter((f) => selected.has(f.id))
  const selecting = selectedFiles.length > 0
  const clearSelection = (): void => {
    setSelected(new Set())
    anchor.current = null
  }
  const toggleFile = (id: number, range: boolean): void => {
    const order = fileList.visible.map((f) => f.id)
    const from = anchor.current === null ? -1 : order.indexOf(anchor.current)
    const to = order.indexOf(id)
    setSelected((current) => {
      const next = new Set(current)
      if (range && from >= 0 && to >= 0) {
        // Like Finder: everything between the last one toggled and this one.
        for (const between of order.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(between)
      } else if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    anchor.current = id
  }
  const allMatchingSelected = fileList.matching.every((f) => selected.has(f.id))
  const selectAllMatching = (): void =>
    setSelected((current) => new Set([...current, ...fileList.matching.map((f) => f.id)]))
  const download = (chosen: SecretMeta[]): void => setModal({ open: true, kind: 'download', files: chosen })

  // Another project: start with nothing selected.
  useEffect(clearSelection, [projectId])

  // Esc clears the selection (when nothing else wants it: a field, a filter, a modal).
  useEffect(() => {
    if (!selecting) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || isTyping(event.target) || isOverlayOpen()) return
      clearSelection()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selecting])

  // Files dropped onto the window go into this project while it is open.
  useEffect(() => {
    if (!project) return
    setDropTarget({ projectId: project.id, name: project.name })
    return () => setDropTarget(null)
  }, [project, setDropTarget])

  useShowSection(!!project)

  // Files dropped onto the window wait in the upload dialog, which opens (or, if
  // open, shows them too). Onto the .env import, a dropped file is read as the .env.
  useEffect(() => {
    if (!dropped || !project) return
    setDropped(null)
    setModal((current) =>
      !current.open || current.kind === 'upload'
        ? { open: true, kind: 'upload', incoming: dropped }
        : current.kind === 'env'
          ? { ...current, incoming: dropped }
          : current
    )
  }, [dropped, project, setDropped])

  const addFiles = (): void => setModal({ open: true, kind: 'upload', incoming: null })

  const addService = (): void => setModal({ open: true, kind: 'service', service: null })
  const addSecret = (): void => setModal({ open: true, kind: 'secret', secret: null })
  const importEnv = (): void => setModal({ open: true, kind: 'env', incoming: null })

  // ⌘N adds a service.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (isModKey(event) && event.key.toLowerCase() === 'n' && !isOverlayOpen()) {
        event.preventDefault()
        addService()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (isLoading) {
    return (
      <Page>
        <div className="flex justify-center py-24 text-muted-foreground">
          <Spinner size={20} />
        </div>
      </Page>
    )
  }
  if (!project) {
    return (
      <Page>
        <EmptyFrame
          title="This project no longer exists"
          description="It may have been deleted."
          action={
            <Button size="lg" onClick={() => navigate('/projects')}>
              Back to projects
            </Button>
          }
        />
      </Page>
    )
  }

  const save = async (patch: { name?: string; description?: string }): Promise<void> => {
    try {
      unwrap(await api.updateProject(project.id, { name: project.name, description: project.description, ...patch }))
      await refreshVault(queryClient)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t save the change')
    }
  }

  const removeProject = async (): Promise<void> => {
    const ok = await confirm({
      title: `Delete project “${project.name}”?`,
      description: `Its ${plural(projectServices.length, 'service')}, ${plural(textSecrets.length, 'secret')} and ${plural(files.length, 'file')} are deleted with it. The accounts stay in your vault.`,
      confirmLabel: 'Delete project',
      destructive: true
    })
    if (!ok) return
    try {
      unwrap(await api.deleteProject(project.id))
      await refreshVault(queryClient)
      toast.success('Project deleted')
      navigate('/projects')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t delete the project')
    }
  }

  const removeService = async (service: Service): Promise<void> => {
    const attached = secrets.filter((s) => s.serviceId === service.id).length
    const ok = await confirm({
      title: `Delete service “${service.name}”?`,
      description: [
        'Its account stays in your vault.',
        attached > 0 && `${plural(attached, 'secret')} attached to it will move to the whole project.`
      ]
        .filter(Boolean)
        .join(' '),
      confirmLabel: 'Delete service',
      destructive: true
    })
    if (!ok) return
    try {
      unwrap(await api.deleteService(service.id))
      await refreshVault(queryClient)
      toast.success('Service deleted')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t delete the service')
    }
  }

  const removeSecret = async (secret: SecretMeta): Promise<void> => {
    const what = secret.kind === 'file' ? 'file' : 'secret'
    const ok = await confirm({
      title: `Delete ${what} “${secret.name}”?`,
      description: `The encrypted ${what} is removed from this vault for good.`,
      confirmLabel: `Delete ${what}`,
      destructive: true
    })
    if (!ok) return
    try {
      unwrap(await api.deleteSecret(secret.id))
      await refreshVault(queryClient)
      toast.success(secret.kind === 'file' ? 'File deleted' : 'Secret deleted')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t delete it')
    }
  }

  const closeModal = (): void => {
    // Files left in a closed upload dialog are not kept.
    if (modal.kind === 'upload') void api.clearStagedFiles()
    setModal((current) => ({ ...current, open: false }))
  }

  const finishDownload = (saved: boolean): void => {
    if (saved) clearSelection()
    closeModal()
  }

  const accountViews = (service: Service): ServiceAccountView[] =>
    service.accounts.flatMap(({ accountId, role }) => {
      const account = accounts.find((a) => a.id === accountId)
      return account ? [{ account, role, via: relationsOf(account.id).signsInWith[0] }] : []
    })

  // What the project depends on: the accounts its services use, then the
  // accounts those sign in through (Vercel signs in with GitHub, say).
  const used = new Map<number, AccountSummary>()
  for (const service of projectServices) {
    for (const { account } of accountViews(service)) used.set(account.id, account)
  }
  const through = new Map<number, { account: AccountSummary; for: string[] }>()
  for (const account of used.values()) {
    for (const via of relationsOf(account.id).signsInWith) {
      if (used.has(via.id)) continue
      const entry = through.get(via.id) ?? { account: via, for: [] }
      entry.for.push(account.domainName)
      through.set(via.id, entry)
    }
  }

  return (
    <Page wide>
      <PageHeader
        crumbs={[{ to: '/projects', label: 'Projects' }]}
        title={<InlineEdit value={project.name} label="Project name" placeholder="Name" onSave={(name) => save({ name })} />}
        description={
          <InlineEdit
            value={project.description}
            label="Description"
            placeholder="Add a description"
            onSave={(description) => save({ description })}
          />
        }
        actions={
          <RowMenu label="Project actions">
            <RowMenuItem icon={Trash} tone="destructive" onClick={() => void removeProject()}>
              Delete project
            </RowMenuItem>
          </RowMenu>
        }
      />

      <RecordColumns
        main={
          <>
            <Section
              id="section-services"
              title="Services"
              action={
                <div className="flex items-center gap-2">
                  <ListFilter list={serviceList} label="Filter services" />
                  <Button size="md" onClick={addService} title={`Add service (${MOD}N)`}>
                    <Plus size={13} weight="bold" />
                    Add service
                  </Button>
                </div>
              }
            >
              <ListFrame footer={listFooter(serviceList, 'service')}>
                {serviceList.visible.map((service) => (
                  <ServiceRow
                    key={service.id}
                    service={service}
                    accounts={accountViews(service)}
                    kept={secrets.filter((s) => s.serviceId === service.id)}
                    expanded={openService === service.id}
                    onToggle={() => setOpenService((open) => (open === service.id ? null : service.id))}
                    onEdit={() => setModal({ open: true, kind: 'service', service })}
                    onDelete={() => void removeService(service)}
                  />
                ))}
                <MoreLine list={serviceList} noun="service" />
                <NoMatchLine list={serviceList} searches="names, addresses, accounts and their roles" />
                {projectServices.length === 0 && (
                  <EmptyLine title="No services yet.">
                    Add what this project runs on (hosting, database, email…) and the account each one uses.
                  </EmptyLine>
                )}
              </ListFrame>
            </Section>

            <Section
              id="section-secrets"
              title="Secrets"
              action={
                <div className="flex items-center gap-2">
                  <ListFilter list={secretList} label="Filter secrets" />
                  <Button size="md" variant="ghost" onClick={importEnv}>
                    <FileArrowUp size={14} />
                    Import .env
                  </Button>
                  <Button size="md" onClick={addSecret}>
                    <Plus size={13} weight="bold" />
                    Add secret
                  </Button>
                </div>
              }
            >
              <ListFrame footer={listFooter(secretList, 'secret')}>
                {secretList.visible.map((secret) => (
                  <SecretRow
                    key={secret.id}
                    secret={secret}
                    serviceName={serviceName(secret.serviceId)}
                    onEdit={() => setModal({ open: true, kind: 'secret', secret })}
                    onDelete={() => void removeSecret(secret)}
                  />
                ))}
                <MoreLine list={secretList} noun="secret" />
                <NoMatchLine list={secretList} searches="names, descriptions and services" />
                {textSecrets.length === 0 && (
                  <EmptyLine title="No secrets yet.">
                    API keys, tokens and environment variables, encrypted with your vault key.
                  </EmptyLine>
                )}
              </ListFrame>
            </Section>

            <Section
              id="section-files"
              title="Files"
              action={
                selecting ? (
                  // The selection bar, in the header's place: same height, nothing below moves.
                  <div className="reveal-in flex min-w-0 items-center gap-2" role="toolbar" aria-label="Selected files">
                    <p className="truncate pr-1 text-[13px] text-muted-foreground tabular-nums" aria-live="polite">
                      <span className="font-medium text-heading">{selectedFiles.length} selected</span>
                      {' · '}
                      {formatSize(selectedFiles.reduce((sum, f) => sum + f.size, 0))}
                    </p>
                    {!allMatchingSelected && (
                      <Button size="md" variant="ghost" onClick={selectAllMatching}>
                        Select all {fileList.matching.length}
                      </Button>
                    )}
                    <Button size="md" variant="ghost" onClick={clearSelection} title="Clear the selection (Esc)">
                      Clear
                    </Button>
                    <Button size="md" variant="primary" onClick={() => download(selectedFiles)}>
                      <DownloadSimple size={14} weight="bold" />
                      Download {selectedFiles.length}
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <ListFilter list={fileList} label="Filter files" />
                    {files.length > 1 && (
                      <Button size="md" variant="ghost" onClick={() => download(files)}>
                        <DownloadSimple size={14} />
                        Download all
                      </Button>
                    )}
                    <Button size="md" onClick={addFiles}>
                      <FilePlus size={14} />
                      Add files
                    </Button>
                  </div>
                )
              }
            >
              <ListFrame footer={listFooter(fileList, 'file')}>
                {fileList.visible.map((secret) => (
                  <SecretRow
                    key={secret.id}
                    secret={secret}
                    serviceName={serviceName(secret.serviceId)}
                    selection={{
                      selected: selected.has(secret.id),
                      selecting,
                      onToggle: (range) => toggleFile(secret.id, range)
                    }}
                    onEdit={() => setModal({ open: true, kind: 'secret', secret })}
                    onDelete={() => void removeSecret(secret)}
                  />
                ))}
                <MoreLine list={fileList} noun="file" />
                <NoMatchLine list={fileList} searches="names, descriptions and services" />
                {files.length === 0 && (
                  <EmptyLine title="No files yet.">
                    SSH keys, certificates, .env files or anything else, encrypted with your vault key. Drop files onto
                    the window, or choose them.
                  </EmptyLine>
                )}
              </ListFrame>
            </Section>
          </>
        }
        side={
          <>
            <Section title="Accounts it depends on">
              <div className="frost divide-y divide-border overflow-hidden rounded-2xl">
                <RelatedGroup
                  label="Used by its services"
                  empty="No service has an account yet"
                  items={[...used.values()].map((a) => ({
                    key: `acc-${a.id}`,
                    title: a.domainName,
                    detail: a.email,
                    onOpen: () => navigate(`/accounts/${a.id}`)
                  }))}
                />
                <RelatedGroup
                  label="Signed in through"
                  empty="Each one has its own sign-in"
                  items={[...through.values()].map(({ account, for: forNames }) => ({
                    key: `via-${account.id}`,
                    title: account.domainName,
                    detail: `${account.email}, for ${forNames.join(', ')}`,
                    onOpen: () => navigate(`/accounts/${account.id}`)
                  }))}
                />
              </div>
              <p className="mt-3 px-1 text-[12px] leading-relaxed text-muted-foreground">
                Losing one of these locks you out of part of this project.
              </p>
            </Section>
            <History createdAt={project.createdAt} updatedAt={project.updatedAt} />
          </>
        }
      />

      <Modal
        open={modal.open}
        // While a download chooses its folder or writes, it has to be finished or stopped.
        onOpenChange={(open) => !open && !downloading && closeModal()}
        closable={!downloading}
        size={modal.kind === 'env' || modal.kind === 'download' ? 'lg' : 'md'}
        title={
          modal.kind === 'download'
            ? 'Download files'
            : modal.kind === 'upload'
            ? 'Add files'
            : modal.kind === 'env'
              ? 'Import .env'
              : modal.kind === 'service'
              ? modal.service
                ? 'Edit service'
                : 'Add service'
              : modal.secret
                ? modal.secret.kind === 'file'
                  ? 'Edit file'
                  : 'Edit secret'
                : 'Add secret'
        }
        description={project.name}
      >
        {modal.kind === 'download' ? (
          <SaveFiles
            projectId={project.id}
            projectName={project.name}
            files={modal.files}
            serviceName={serviceName}
            onBusyChange={setDownloading}
            onDone={finishDownload}
          />
        ) : modal.kind === 'upload' ? (
          <UploadFiles projectId={project.id} services={projectServices} incoming={modal.incoming} onDone={closeModal} />
        ) : modal.kind === 'env' ? (
          <ImportEnv
            projectId={project.id}
            services={projectServices}
            secrets={textSecrets}
            incoming={modal.incoming}
            onDone={closeModal}
          />
        ) : modal.kind === 'service' ? (
          <ServiceForm
            key={modal.service?.id ?? 'new'}
            projectId={project.id}
            service={modal.service} onCancel={closeModal} onSaved={closeModal} />
        ) : (
          <SecretForm
            key={modal.secret?.id ?? 'new'}
            projectId={project.id}
            secret={modal.secret}
            services={projectServices}
            onCancel={closeModal}
            onSaved={closeModal}
          />
        )}
      </Modal>
      {dialog}
    </Page>
  )
}
