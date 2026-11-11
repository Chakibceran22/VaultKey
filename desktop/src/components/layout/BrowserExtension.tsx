import { useState } from 'react'
import { CheckCircle } from '@phosphor-icons/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/misc'
import { Modal, ModalBody, ModalFooter } from '@renderer/components/ui/overlays'
import { api } from '@renderer/lib/api'
import { unwrap } from '@renderer/lib/ipc'
import { toast } from '@renderer/lib/toast'
import type { BridgeSettings, PairedBrowser } from '@renderer/shared/contracts'

export const BRIDGE_QUERY = ['bridge'] as const

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

/** "2 minutes ago", "yesterday", "3 weeks ago". */
function ago(iso: string): string {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
    ['week', 4.35],
    ['month', 12],
    ['year', Infinity]
  ]
  let value = seconds
  for (const [unit, size] of steps) {
    if (Math.abs(value) < size) return relative.format(Math.round(value), unit)
    value /= size
  }
  return relative.format(Math.round(value), 'year')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.'
}

/**
 * Settings → Browser extension: turn it on or off, see which browsers can reach
 * VaultKey, and disconnect a paired browser. Pairing itself starts in the extension and
 * is approved in the dialog VaultKey shows then (PairingDialog).
 */
export function BrowserExtension({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Browser extension"
      description="The VaultKey extension asks this vault for your logins. Only browsers you pair here can reach it, and only while the vault is unlocked."
    >
      {open && <Settings onClose={() => onOpenChange(false)} />}
    </Modal>
  )
}

function Settings({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()
  const settings = useQuery({ queryKey: BRIDGE_QUERY, queryFn: async () => unwrap(await api.bridgeSettings()) })
  const [busy, setBusy] = useState(false)

  const apply = (data: BridgeSettings): void => {
    queryClient.setQueryData(BRIDGE_QUERY, data)
  }

  async function toggle(data: BridgeSettings, enabled: boolean): Promise<void> {
    setBusy(true)
    try {
      const next = unwrap(await api.setBridgeEnabled(enabled))
      apply(next)
      if (enabled && !next.listening) toast.error('VaultKey couldn’t start listening for the browsers.')
      else if (enabled !== data.enabled) toast.success(enabled ? 'Browser extension turned on' : 'Browser extension turned off')
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function disconnect(browser: PairedBrowser): Promise<void> {
    try {
      apply(unwrap(await api.revokeBrowser(browser.id)))
      toast.success(`${browser.name} disconnected`)
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  const data = settings.data
  const installed = data?.browsers.filter((browser) => browser.installed) ?? []

  return (
    <>
      <ModalBody>
        {settings.isPending ? (
          <div className="flex justify-center py-8 text-muted-foreground">
            <Spinner />
          </div>
        ) : settings.isError || !data ? (
          <p className="text-[13.5px] text-destructive">{errorMessage(settings.error)}</p>
        ) : (
          <>
            <section className="flex items-center gap-4 rounded-xl border px-4 py-3.5">
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-medium text-heading">{data.enabled ? 'On' : 'Off'}</p>
                <p
                  className={`mt-0.5 text-[12.5px] leading-relaxed ${data.enabled && !data.listening ? 'text-destructive' : 'text-muted-foreground'}`}
                >
                  {!data.available
                    ? data.dev
                      ? 'Build the bridge first: cargo build -p vaultkey-bridge, in src-tauri.'
                      : 'This build of VaultKey doesn’t include the browser bridge yet.'
                    : data.enabled && !data.listening
                      ? 'VaultKey couldn’t start listening for the browsers. Is another VaultKey open?'
                      : data.enabled
                        ? 'Paired browsers can reach VaultKey while it’s unlocked.'
                        : 'No browser can reach VaultKey.'}
                </p>
              </div>
              {data.enabled && !data.listening && data.available && (
                <Button disabled={busy} onClick={() => void toggle(data, true)}>
                  Try again
                </Button>
              )}
              <Button
                variant={data.enabled ? 'secondary' : 'primary'}
                disabled={busy || (!data.enabled && !data.available)}
                onClick={() => void toggle(data, !data.enabled)}
              >
                {busy && <Spinner size={14} />}
                {data.enabled ? 'Turn off' : 'Turn on'}
              </Button>
            </section>
            {data.dev && (
              <p className="text-[12.5px] text-muted-foreground">
                Dev build: it pairs with the dev extension only, and uses the dev vault.
              </p>
            )}

            {data.enabled && (
              <section className="space-y-2">
                <h3 className="text-[13px] font-semibold text-heading">Browsers</h3>
                {installed.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">
                    No supported browser found. Brave, Chrome, Edge and Chromium are supported.
                  </p>
                ) : (
                  <ul className="divide-y rounded-xl border">
                    {installed.map((browser) => (
                      <li key={browser.name} className="flex items-center gap-3 px-4 py-2.5 text-[13.5px]">
                        <span className="flex-1 text-heading">{browser.name}</span>
                        {browser.registered ? (
                          <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                            <CheckCircle size={15} weight="fill" className="text-primary" />
                            Ready
                          </span>
                        ) : (
                          <span className="text-[12.5px] text-destructive">Not registered</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            <section className="space-y-2">
              <h3 className="text-[13px] font-semibold text-heading">Paired browsers</h3>
              {data.paired.length === 0 ? (
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                  {data.enabled
                    ? 'None yet. Open the VaultKey extension in your browser and click Connect to VaultKey.'
                    : 'None yet. Turn the extension on first.'}
                </p>
              ) : (
                <ul className="divide-y rounded-xl border">
                  {data.paired.map((browser) => (
                    <PairedRow key={browser.id} browser={browser} onDisconnect={() => disconnect(browser)} />
                  ))}
                </ul>
              )}
            </section>

            {data.enabled && (
              <section className="space-y-2">
                <h3 className="text-[13px] font-semibold text-heading">Recent fills</h3>
                {data.recent.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">
                    Nothing filled since the vault was unlocked. Each fill shows here, so you can spot one you didn’t
                    make.
                  </p>
                ) : (
                  <ul className="divide-y rounded-xl border">
                    {data.recent.map((fill, i) => (
                      <li key={`${fill.at}-${i}`} className="px-4 py-2.5">
                        <p className="truncate text-[13.5px] text-heading">
                          {fill.what === 'code' ? 'Code for ' : ''}
                          {fill.account}
                        </p>
                        <p className="text-[12px] text-muted-foreground">
                          On {fill.site} · {fill.browser} · {ago(fill.at)}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </>
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </ModalFooter>
    </>
  )
}

/** One paired browser; Disconnect asks inline, naming it, before anything happens. */
function PairedRow({ browser, onDisconnect }: { browser: PairedBrowser; onDisconnect: () => Promise<void> }) {
  const [asking, setAsking] = useState(false)
  const [working, setWorking] = useState(false)
  return (
    <li className="px-4 py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] text-heading">{browser.name}</p>
          <p className="text-[12px] text-muted-foreground">
            Paired {ago(browser.createdAt)} · last used {ago(browser.lastSeenAt)}
          </p>
        </div>
        {!asking && (
          <Button variant="destructive-ghost" size="sm" onClick={() => setAsking(true)}>
            Disconnect
          </Button>
        )}
      </div>
      {asking && (
        <div className="mt-2 flex items-center gap-2 rounded-lg bg-destructive/8 px-3 py-2">
          <p className="flex-1 text-[12.5px] text-foreground">
            Disconnect {browser.name}? It has to pair again to reach VaultKey.
          </p>
          <Button size="sm" variant="ghost" disabled={working} onClick={() => setAsking(false)}>
            Keep
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={working}
            onClick={async () => {
              setWorking(true)
              await onDisconnect()
              setWorking(false)
              setAsking(false)
            }}
          >
            Disconnect browser
          </Button>
        </div>
      )}
    </li>
  )
}
