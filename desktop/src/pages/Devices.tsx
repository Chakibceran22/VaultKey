import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { PencilSimple, Plus, Trash, Warning } from '@phosphor-icons/react'
import { useQueryClient } from '@tanstack/react-query'
import type { Device } from '@renderer/shared/contracts'
import { DEVICES, FACTORS } from '@renderer/components/accounts/kinds'
import { BODY_INSET, Expand, LinkLine, RowHeader } from '@renderer/components/accounts/parts'
import { DeviceModal } from '@renderer/components/devices/DeviceModal'
import { EmptyFrame, ListFrame, Page, PageHeader } from '@renderer/components/layout/page'
import { Button } from '@renderer/components/ui/button'
import { useConfirm } from '@renderer/components/ui/confirm'
import { SearchField } from '@renderer/components/ui/controls'
import { Spinner } from '@renderer/components/ui/misc'
import { byName, plural, refreshVault, useAccountDetails, useDeviceUsage, type DeviceUsage } from '@renderer/hooks/use-vault'
import { api } from '@renderer/lib/api'
import { isModKey, isTyping, MOD, isOverlayOpen } from '@renderer/lib/dom'
import { unwrap } from '@renderer/lib/ipc'
import { toast } from '@renderer/lib/toast'
import { cn } from '@renderer/lib/utils'

const rowDomId = (id: number): string => `device-${id}`

/** "Used by 4 accounts" */
function usageSummary(usage: DeviceUsage): string {
  const accounts = new Set([...usage.steps.map((s) => s.account.id), ...usage.signedIn.map((a) => a.id)])
  return accounts.size ? `Used by ${plural(accounts.size, 'account')}` : 'Nothing linked yet'
}

/**
 * Pattern: List / Index. The phones, computers and keys accounts depend on. A
 * row opens in place to show what lives on the device, and which accounts
 * would be hard to get back into without it.
 */
export default function Devices(): React.ReactElement {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [params, setParams] = useSearchParams()
  const { devices, isLoading } = useAccountDetails()
  const usageOf = useDeviceUsage()
  const { confirm, dialog } = useConfirm()
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<number | null>(null)
  const [active, setActive] = useState(-1)
  const [modal, setModal] = useState<{ open: boolean; device: Device | null }>({ open: false, device: null })
  const searchRef = useRef<HTMLInputElement>(null)

  const needle = query.trim().toLowerCase()
  const visible = useMemo(
    () =>
      [...devices]
        .sort((a, b) => byName(a.name, b.name))
        .filter((d) => !needle || `${d.name} ${DEVICES[d.kind].name} ${d.notes}`.toLowerCase().includes(needle)),
    [devices, needle]
  )
  const current = visible.length ? Math.min(active, visible.length - 1) : -1

  const open = (id: number): void => {
    setQuery('')
    setExpanded(id)
    requestAnimationFrame(() =>
      document.getElementById(rowDomId(id))?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    )
  }

  // Deep links from accounts and the search: /devices?open=3
  useEffect(() => {
    const id = Number(params.get('open'))
    if (!id) return
    open(id)
    setParams({}, { replace: true })
  }, [params, setParams])

  // "/" focuses the search; ⌘N adds a device.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === '/' && !isTyping(event.target) && !isOverlayOpen()) {
        event.preventDefault()
        searchRef.current?.focus()
      } else if (isModKey(event) && event.key.toLowerCase() === 'n' && !isOverlayOpen()) {
        event.preventDefault()
        setModal({ open: true, device: null })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const toggle = (id: number, index: number): void => {
    setActive(index)
    setExpanded((now) => (now === id ? null : id))
  }

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!visible.length) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive(current < 0 ? (step > 0 ? 0 : visible.length - 1) : (current + step + visible.length) % visible.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const target = current >= 0 ? current : visible.length === 1 ? 0 : -1
      if (target >= 0) toggle(visible[target].id, target)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      if (expanded) setExpanded(null)
      else if (query) setQuery('')
    }
  }

  const remove = async (device: Device, usage: DeviceUsage): Promise<void> => {
    const ok = await confirm({
      title: `Delete “${device.name}”?`,
      description: [
        'The device is removed from VaultKey.',
        usage.steps.length > 0 &&
          `${plural(usage.steps.length, 'sign-in step')} on it stay with their accounts, no longer tied to a device.`,
        usage.signedIn.length > 0 && `${plural(usage.signedIn.length, 'account')} will no longer show it.`
      ]
        .filter(Boolean)
        .join(' '),
      confirmLabel: 'Delete device',
      destructive: true
    })
    if (!ok) return
    try {
      unwrap(await api.deleteDevice(device.id))
      setExpanded(null)
      await refreshVault(queryClient)
      toast.success('Device deleted')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t delete the device')
    }
  }

  const add = (): void => setModal({ open: true, device: null })

  return (
    <Page>
      <PageHeader
        title="Devices"
        description="The phones, computers and keys your accounts depend on, and what you would lose with each."
        actions={
          <Button variant="primary" size="lg" onClick={add} title={`New device (${MOD}N)`}>
            <Plus size={14} weight="bold" />
            New device
          </Button>
        }
      />

      <div className="mt-6">
        <SearchField
          inputRef={searchRef}
          value={query}
          onChange={(value) => {
            setQuery(value)
            setActive(-1)
          }}
          onKeyDown={onSearchKey}
          placeholder="Search devices"
          role="combobox"
          aria-expanded="true"
          aria-controls="device-list"
          aria-activedescendant={current >= 0 ? rowDomId(visible[current].id) : undefined}
        />
      </div>

      <div className="mt-4">
        {isLoading ? (
          <div className="flex justify-center py-16 text-muted-foreground">
            <Spinner size={20} />
          </div>
        ) : visible.length === 0 ? (
          <EmptyFrame
            title={needle ? `No device matches “${query.trim()}”` : 'No devices yet'}
            description={
              needle
                ? 'Check the spelling, or add it as a new device.'
                : 'Add your phone, computers and security keys, then note which accounts use them for sign-in.'
            }
            action={
              <Button variant="primary" size="lg" onClick={add}>
                <Plus size={14} weight="bold" />
                New device
              </Button>
            }
          />
        ) : (
          <ListFrame id="device-list" footer={plural(devices.length, 'device')}>
            {visible.map((device, index) => {
              const usage = usageOf(device.id)
              const isOpen = expanded === device.id
              const accountChip = (account: { id: number; domainName: string }, detail?: string) => ({
                key: `${account.id}-${detail ?? ''}`,
                title: account.domainName,
                detail,
                onOpen: () => navigate(`/accounts/${account.id}`)
              })
              return (
                <li key={device.id} className={cn('transition-colors duration-200', isOpen && 'bg-secondary/30')}>
                  <RowHeader
                    id={rowDomId(device.id)}
                    title={device.name}
                    subtitle={DEVICES[device.kind].name}
                    icon={DEVICES[device.kind].icon}
                    meta={
                      <>
                        {usage.noBackup.length > 0 && <Warning size={14} className="shrink-0 text-warning" />}
                        <span className="truncate">{usageSummary(usage)}</span>
                      </>
                    }
                    expanded={isOpen}
                    active={index === current}
                    onToggle={() => toggle(device.id, index)}
                  />
                  <Expand open={isOpen}>
                    <div className={BODY_INSET}>
                      <LinkLine
                        label="Sign-in steps"
                        items={usage.steps.map(({ factor, account }) =>
                          accountChip(account, FACTORS[factor.kind].name.toLowerCase())
                        )}
                        empty="None on this device"
                      />
                      <LinkLine
                        label="Signed in to"
                        items={usage.signedIn.map((account) => accountChip(account, account.note || undefined))}
                        empty="No account noted"
                      />
                      {usage.noBackup.length > 0 && (
                        <div className="my-1.5 rounded-lg border bg-background/50 px-3 py-2.5 dark:bg-white/4">
                          <p className="flex items-center gap-2 text-[13px] font-medium text-heading">
                            <Warning size={14} className="text-warning" />
                            If you lose it
                          </p>
                          <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
                            {usage.noBackup.map((a) => a.domainName).join(', ')}{' '}
                            {usage.noBackup.length === 1 ? 'has' : 'have'} no recovery codes, recovery account or other
                            second step saved.
                          </p>
                        </div>
                      )}
                      {device.notes && (
                        <p className="py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                          {device.notes}
                        </p>
                      )}
                      <div className="mt-2 flex items-center gap-2 border-t pt-3">
                        <Button variant="ghost" size="sm" onClick={() => setModal({ open: true, device })}>
                          <PencilSimple size={14} />
                          Edit
                        </Button>
                        <span className="flex-1" />
                        <Button variant="destructive-ghost" size="sm" onClick={() => void remove(device, usage)}>
                          <Trash size={14} />
                          Delete
                        </Button>
                      </div>
                    </div>
                  </Expand>
                </li>
              )
            })}
          </ListFrame>
        )}
      </div>

      <DeviceModal
        open={modal.open}
        onOpenChange={(isOpen) => !isOpen && setModal((m) => ({ ...m, open: false }))}
        device={modal.device}
        onSaved={(id) => open(id)}
      />
      {dialog}
    </Page>
  )
}
