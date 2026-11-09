import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Tabs } from '@base-ui/react/tabs'
import { FilePlus, Plus, Trash } from '@phosphor-icons/react'
import { useQueryClient } from '@tanstack/react-query'
import type { SecretMeta, Service } from '@renderer/shared/contracts'
import { EmptyFrame, ListFrame, Page, PageHeader } from '@renderer/components/layout/page'
import { SecretRow, ServiceRow } from '@renderer/components/projects/rows'
import { SecretForm, ServiceForm } from '@renderer/components/projects/forms'
import { Button } from '@renderer/components/ui/button'
import { useConfirm } from '@renderer/components/ui/confirm'
import { InlineEdit } from '@renderer/components/ui/controls'
import { Spinner } from '@renderer/components/ui/misc'
import { Modal, RowMenu, RowMenuItem } from '@renderer/components/ui/overlays'
import { plural, refreshVault, useAccounts, useRelations, useWorkspace } from '@renderer/hooks/use-vault'
import { api } from '@renderer/lib/api'
import { isModKey, isOverlayOpen } from '@renderer/lib/dom'
import { useDropTarget } from '@renderer/lib/drop-target'
import { unwrap } from '@renderer/lib/ipc'
import { toast } from '@renderer/lib/toast'

type Tab = 'services' | 'secrets' | 'files'
const TABS: Tab[] = ['services', 'secrets', 'files']

type ModalState =
  | { open: boolean; kind: 'service'; service: Service | null }
  | { open: boolean; kind: 'secret'; secret: SecretMeta | null }

/**
 * Pattern: Detail / Record. One project: name and description edited in place,
 * then a tab per kind of thing it holds. Each tab owns its list, empty state
 * and primary action; adding and editing happen in a modal.
 */
export default function ProjectPage(): React.ReactElement {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { projectId: rawId } = useParams()
  const projectId = Number(rawId)
  const [params, setParams] = useSearchParams()
  const tab: Tab = TABS.includes(params.get('tab') as Tab) ? (params.get('tab') as Tab) : 'services'
  const { projects, services, secrets, isLoading } = useWorkspace()
  const { accounts } = useAccounts()
  const relationsOf = useRelations()
  const { confirm, dialog } = useConfirm()
  const setDropTarget = useDropTarget((s) => s.setTarget)
  const [modal, setModal] = useState<ModalState>({ open: false, kind: 'service', service: null })

  const project = projects.find((p) => p.id === projectId)
  const projectServices = services.filter((s) => s.projectId === projectId)
  const textSecrets = secrets.filter((s) => s.projectId === projectId && s.kind === 'text')
  const files = secrets.filter((s) => s.projectId === projectId && s.kind === 'file')
  const serviceName = (id: number | null): string | undefined => projectServices.find((s) => s.id === id)?.name

  // Files dropped onto the window go into this project while it is open.
  useEffect(() => {
    if (!project) return
    setDropTarget({ projectId: project.id, name: project.name })
    return () => setDropTarget(null)
  }, [project, setDropTarget])

  const setTab = (next: Tab): void => setParams({ tab: next }, { replace: true })

  const addFiles = async (): Promise<void> => {
    try {
      const report = unwrap(await api.importFiles(projectId, null))
      await refreshVault(queryClient)
      if (report.imported.length) toast.success(`${plural(report.imported.length, 'file')} added`)
      for (const skipped of report.skipped) toast.error(`${skipped.name}: ${skipped.reason}`)
      setTab('files')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t add the files')
    }
  }

  const add = (which: Tab = tab): void => {
    if (which === 'services') setModal({ open: true, kind: 'service', service: null })
    else if (which === 'secrets') setModal({ open: true, kind: 'secret', secret: null })
    else void addFiles()
  }

  // ⌘N adds to the open tab.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (isModKey(event) && event.key.toLowerCase() === 'n' && !isOverlayOpen()) {
        event.preventDefault()
        add()
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

  const closeModal = (): void => setModal((current) => ({ ...current, open: false }))
  const count = (n: number) => (
    <span className="ml-1.5 text-muted-foreground tabular-nums">
      <span className="sr-only">, </span>
      {n}
    </span>
  )

  return (
    <Page>
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

      <Tabs.Root value={tab} onValueChange={(value) => setTab(value as Tab)} className="mt-8">
        <div className="flex items-end justify-between gap-4 border-b">
          <Tabs.List className="relative flex gap-6">
            {(
              [
                ['services', 'Services', projectServices.length],
                ['secrets', 'Secrets', textSecrets.length],
                ['files', 'Files', files.length]
              ] as const
            ).map(([value, label, n]) => (
              <Tabs.Tab
                key={value}
                value={value}
                className="cursor-pointer pb-3 text-[14px] font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:text-heading data-active:text-heading"
              >
                {label}
                {count(n)}
              </Tabs.Tab>
            ))}
            <Tabs.Indicator className="absolute bottom-[-1px] left-(--active-tab-left) h-0.5 w-(--active-tab-width) rounded-full bg-primary transition-[left,width] duration-200 ease-smooth motion-reduce:transition-none" />
          </Tabs.List>
          <div className="pb-2">
            {tab === 'services' && (
              <Button size="md" onClick={() => add('services')}>
                <Plus size={13} weight="bold" />
                Add service
              </Button>
            )}
            {tab === 'secrets' && (
              <Button size="md" onClick={() => add('secrets')}>
                <Plus size={13} weight="bold" />
                Add secret
              </Button>
            )}
            {tab === 'files' && (
              <Button size="md" onClick={() => add('files')}>
                <FilePlus size={14} />
                Add files
              </Button>
            )}
          </div>
        </div>

        <Tabs.Panel value="services" className="mt-4 outline-none">
          {projectServices.length === 0 ? (
            <EmptyFrame
              title="No services yet"
              description="Add what this project runs on (hosting, database, email…) and the account each one uses."
              action={
                <Button variant="primary" size="lg" onClick={() => add('services')}>
                  <Plus size={14} weight="bold" />
                  Add service
                </Button>
              }
            />
          ) : (
            <ListFrame footer={plural(projectServices.length, 'service')}>
              {projectServices.map((service) => {
                const account = accounts.find((a) => a.id === service.accountId)
                return (
                  <ServiceRow
                    key={service.id}
                    service={service}
                    account={account}
                    relations={account ? relationsOf(account.id) : undefined}
                    onEdit={() => setModal({ open: true, kind: 'service', service })}
                    onDelete={() => void removeService(service)}
                  />
                )
              })}
            </ListFrame>
          )}
        </Tabs.Panel>

        <Tabs.Panel value="secrets" className="mt-4 outline-none">
          {textSecrets.length === 0 ? (
            <EmptyFrame
              title="No secrets yet"
              description="API keys, tokens and environment variables, encrypted with your vault key."
              action={
                <Button variant="primary" size="lg" onClick={() => add('secrets')}>
                  <Plus size={14} weight="bold" />
                  Add secret
                </Button>
              }
            />
          ) : (
            <ListFrame footer={plural(textSecrets.length, 'secret')}>
              {textSecrets.map((secret) => (
                <SecretRow
                  key={secret.id}
                  secret={secret}
                  serviceName={serviceName(secret.serviceId)}
                  onEdit={() => setModal({ open: true, kind: 'secret', secret })}
                  onDelete={() => void removeSecret(secret)}
                />
              ))}
            </ListFrame>
          )}
        </Tabs.Panel>

        <Tabs.Panel value="files" className="mt-4 outline-none">
          {files.length === 0 ? (
            <EmptyFrame
              title="No files yet"
              description="SSH keys, certificates, .env files or anything else, encrypted with your vault key. Drop files onto the window, or choose them."
              action={
                <Button variant="primary" size="lg" onClick={() => add('files')}>
                  <FilePlus size={15} />
                  Add files
                </Button>
              }
            />
          ) : (
            <ListFrame footer={<>{plural(files.length, 'file')}. Drop more onto the window to add them.</>}>
              {files.map((secret) => (
                <SecretRow
                  key={secret.id}
                  secret={secret}
                  serviceName={serviceName(secret.serviceId)}
                  onEdit={() => setModal({ open: true, kind: 'secret', secret })}
                  onDelete={() => void removeSecret(secret)}
                />
              ))}
            </ListFrame>
          )}
        </Tabs.Panel>
      </Tabs.Root>

      <Modal
        open={modal.open}
        onOpenChange={(open) => !open && closeModal()}
        title={
          modal.kind === 'service'
            ? modal.service
              ? 'Edit service'
              : 'Add service'
            : modal.secret
              ? modal.secret.kind === 'file'
                ? 'Rename or move file'
                : 'Edit secret'
              : 'Add secret'
        }
        description={project.name}
      >
        {modal.kind === 'service' ? (
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
