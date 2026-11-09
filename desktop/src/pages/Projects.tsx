import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { CaretRight, FolderSimple, Plus } from '@phosphor-icons/react'
import { EmptyFrame, ListFrame, Page, PageHeader } from '@renderer/components/layout/page'
import { ProjectForm } from '@renderer/components/projects/forms'
import { Button } from '@renderer/components/ui/button'
import { SearchField } from '@renderer/components/ui/controls'
import { Spinner } from '@renderer/components/ui/misc'
import { Modal } from '@renderer/components/ui/overlays'
import { plural, useWorkspace } from '@renderer/hooks/use-vault'
import { isModKey, isTyping, MOD, isOverlayOpen } from '@renderer/lib/dom'

/** Pattern: List / Index. One row per project; a row opens the project. */
export default function Projects(): React.ReactElement {
  const navigate = useNavigate()
  const { projects, services, secrets, isLoading } = useWorkspace()
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  const needle = query.trim().toLowerCase()
  const visible = useMemo(
    () => projects.filter((p) => !needle || `${p.name} ${p.description}`.toLowerCase().includes(needle)),
    [projects, needle]
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === '/' && !isTyping(event.target) && !isOverlayOpen()) {
        event.preventDefault()
        searchRef.current?.focus()
      } else if (isModKey(event) && event.key.toLowerCase() === 'n' && !isOverlayOpen()) {
        event.preventDefault()
        setCreating(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const counts = (projectId: number): string => {
    const s = services.filter((x) => x.projectId === projectId).length
    const t = secrets.filter((x) => x.projectId === projectId && x.kind === 'text').length
    const f = secrets.filter((x) => x.projectId === projectId && x.kind === 'file').length
    return [plural(s, 'service'), plural(t, 'secret'), plural(f, 'file')].join(', ')
  }

  return (
    <Page>
      <PageHeader
        title="Projects"
        description="The services each project runs on, with their keys and files."
        actions={
          <Button variant="primary" size="lg" onClick={() => setCreating(true)} title={`New project (${MOD}N)`}>
            <Plus size={14} weight="bold" />
            New project
          </Button>
        }
      />
      <div className="mt-6">
        <SearchField inputRef={searchRef} value={query} onChange={setQuery} placeholder="Search projects" />
      </div>
      <div className="mt-4">
        {isLoading ? (
          <div className="flex justify-center py-16 text-muted-foreground">
            <Spinner size={20} />
          </div>
        ) : visible.length === 0 ? (
          <EmptyFrame
            title={needle ? `No project matches “${query.trim()}”` : 'No projects yet'}
            description={
              needle
                ? 'Check the spelling, or create it.'
                : 'A project keeps the services it runs on, the accounts they use, and its API keys and files together.'
            }
            action={
              <Button variant="primary" size="lg" onClick={() => setCreating(true)}>
                <Plus size={14} weight="bold" />
                New project
              </Button>
            }
          />
        ) : (
          <ListFrame footer={needle ? plural(visible.length, 'result') : plural(projects.length, 'project')}>
            {visible.map((project) => (
              <li key={project.id}>
                <Link
                  to={`/projects/${project.id}`}
                  className="grid grid-cols-[2rem_minmax(0,1fr)_auto_1rem] items-center gap-x-4 px-4 py-3 transition-colors duration-150 outline-none hover:bg-secondary/40 focus-visible:bg-secondary/60"
                >
                  <span className="flex size-8 items-center justify-center rounded-[9px] bg-primary/10 text-primary dark:bg-primary/15">
                    <FolderSimple size={16} weight="fill" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-[14.5px] font-medium text-heading">{project.name}</p>
                    <p className="truncate text-[13px] text-muted-foreground">{project.description || 'No description'}</p>
                  </div>
                  <span className="hidden text-[13px] text-muted-foreground tabular-nums @min-[36rem]:inline">
                    {counts(project.id)}
                  </span>
                  <CaretRight size={13} weight="bold" className="justify-self-end text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ListFrame>
        )}
      </div>

      <Modal open={creating} onOpenChange={setCreating} title="New project" description="You can add services, secrets and files next.">
        <ProjectForm onCancel={() => setCreating(false)} onCreated={(id) => navigate(`/projects/${id}`)} />
      </Modal>
    </Page>
  )
}
