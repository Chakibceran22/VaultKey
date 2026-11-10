import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { FilePlus, Plus, Trash } from '@phosphor-icons/react'
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
import { Button } from '@renderer/components/ui/button'
import { useConfirm } from '@renderer/components/ui/confirm'
import { InlineEdit } from '@renderer/components/ui/controls'
import { Spinner } from '@renderer/components/ui/misc'
import { Modal, RowMenu, RowMenuItem } from '@renderer/components/ui/overlays'
import { plural, refreshVault, useAccounts, useRelations, useWorkspace } from '@renderer/hooks/use-vault'
import { api } from '@renderer/lib/api'
import { isModKey, isOverlayOpen, MOD } from '@renderer/lib/dom'
import { useDropTarget } from '@renderer/lib/drop-target'
import { unwrap } from '@renderer/lib/ipc'
import { toast } from '@renderer/lib/toast'

type ModalState =
  | { open: boolean; kind: 'service'; service: Service | null }
  | { open: boolean; kind: 'secret'; secret: SecretMeta | null }
  | { open: boolean; kind: 'upload'; incoming: StagedList | null }

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

  useShowSection(!!project)

  // Files dropped onto the window wait in the upload dialog, which opens (or, if
  // open, shows them too).
  useEffect(() => {
    if (!dropped || !project) return
    setDropped(null)
    setModal((current) =>
      current.open && current.kind !== 'upload' ? current : { open: true, kind: 'upload', incoming: dropped }
    )
  }, [dropped, project, setDropped])

  const addFiles = (): void => setModal({ open: true, kind: 'upload', incoming: null })

  const addService = (): void => setModal({ open: true, kind: 'service', service: null })
  const addSecret = (): void => setModal({ open: true, kind: 'secret', secret: null })

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
                <Button size="md" onClick={addService} title={`Add service (${MOD}N)`}>
                  <Plus size={13} weight="bold" />
                  Add service
                </Button>
              }
            >
              <ListFrame footer={projectServices.length > 0 ? plural(projectServices.length, 'service') : undefined}>
                {projectServices.map((service) => (
                  <ServiceRow
                    key={service.id}
                    service={service}
                    accounts={accountViews(service)}
                    onEdit={() => setModal({ open: true, kind: 'service', service })}
                    onDelete={() => void removeService(service)}
                  />
                ))}
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
                <Button size="md" onClick={addSecret}>
                  <Plus size={13} weight="bold" />
                  Add secret
                </Button>
              }
            >
              <ListFrame footer={textSecrets.length > 0 ? plural(textSecrets.length, 'secret') : undefined}>
                {textSecrets.map((secret) => (
                  <SecretRow
                    key={secret.id}
                    secret={secret}
                    serviceName={serviceName(secret.serviceId)}
                    onEdit={() => setModal({ open: true, kind: 'secret', secret })}
                    onDelete={() => void removeSecret(secret)}
                  />
                ))}
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
                <Button size="md" onClick={addFiles}>
                  <FilePlus size={14} />
                  Add files
                </Button>
              }
            >
              <ListFrame
                footer={
                  files.length > 0 ? <>{plural(files.length, 'file')}. Drop more onto the window to add them.</> : undefined
                }
              >
                {files.map((secret) => (
                  <SecretRow
                    key={secret.id}
                    secret={secret}
                    serviceName={serviceName(secret.serviceId)}
                    onEdit={() => setModal({ open: true, kind: 'secret', secret })}
                    onDelete={() => void removeSecret(secret)}
                  />
                ))}
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
        onOpenChange={(open) => !open && closeModal()}
        title={
          modal.kind === 'upload'
            ? 'Add files'
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
        {modal.kind === 'upload' ? (
          <UploadFiles projectId={project.id} services={projectServices} incoming={modal.incoming} onDone={closeModal} />
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
