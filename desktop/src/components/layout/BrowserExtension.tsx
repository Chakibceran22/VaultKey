import { useId, useState } from 'react'
import { CheckCircle } from '@phosphor-icons/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { SiteTile, Spinner } from '@renderer/components/ui/misc'
import { ModalBody } from '@renderer/components/ui/overlays'
import { plural, refreshVault } from '@renderer/hooks/use-vault'
import { api } from '@renderer/lib/api'
import { unwrap } from '@renderer/lib/ipc'
import { toast } from '@renderer/lib/toast'
import type { BridgeSettings, PairedBrowser, RecentFill, UnmatchedWebsite } from '@renderer/shared/contracts'

export const BRIDGE_QUERY = ['bridge'] as const
export const UNMATCHED_QUERY = ['unmatched-websites'] as const

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
 * VaultKey, disconnect a paired browser, give name-only websites an address, and see what
 * was filled. Pairing itself starts in the extension and is approved in the dialog
 * VaultKey shows then (PairingDialog).
 */
export function BrowserExtensionPanel() {
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
    <ModalBody>
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        The VaultKey extension asks this vault for your logins. Only browsers you pair here can reach it, and only
        while the vault is unlocked.
      </p>
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
                    ? 'Build the bridge first: pnpm bridge:dev, in desktop/.'
                    : 'This build of VaultKey doesn’t include the browser bridge.'
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

          {data.enabled && <UnmatchedWebsites />}

          {data.enabled && <RecentFills recent={data.recent} />}
        </>
      )}
    </ModalBody>
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

/**
 * Websites saved as a name ("GitHub") rather than an address: the extension can't tell
 * which pages they're for, so their accounts never fill. Each gets its address here, in
 * one click when VaultKey can tell what it is. Nothing shows when there are none.
 */
function UnmatchedWebsites() {
  const query = useQuery({ queryKey: UNMATCHED_QUERY, queryFn: async () => unwrap(await api.unmatchedWebsites()) })
  const websites = query.data?.websites ?? []
  if (!query.isError && websites.length === 0) return null
  return (
    <section className="space-y-2">
      <h3 className="text-[13px] font-semibold text-heading">Websites the extension can’t match</h3>
      {query.isError ? (
        <p className="text-[13px] text-destructive">{errorMessage(query.error)}</p>
      ) : (
        <>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            These are saved as a name, not an address, so the extension can’t tell which pages they’re for. Give
            each one its address and its accounts fill there too.
          </p>
          <ul className="divide-y rounded-xl border">
            {websites.map((website) => (
              <UnmatchedRow key={website.domainId} website={website} />
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

/** One name-only website: "Use github.com" when there's a likely address, or a field to type it. */
function UnmatchedRow({ website }: { website: UnmatchedWebsite }) {
  const queryClient = useQueryClient()
  const id = useId()
  // Without a suggestion, the field is the only way: it shows from the start.
  const [typing, setTyping] = useState(website.suggestion === null)
  const [focus, setFocus] = useState(false)
  const [address, setAddress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function save(value: string): Promise<void> {
    const wanted = value.trim()
    if (!wanted) return
    setSaving(true)
    setError(null)
    const result = await api.setWebsiteAddress(website.domainId, wanted)
    setSaving(false)
    if (!result.ok) {
      const { code, message } = result.error
      if (code === 'NOT_FOUND') {
        // Deleted meanwhile (in another part of the app): show the list as it is now.
        toast.message(`${website.name} isn’t in your vault any more`)
        void queryClient.invalidateQueries({ queryKey: UNMATCHED_QUERY })
        void refreshVault(queryClient)
        return
      }
      setError(
        code === 'ALREADY_EXISTS'
          ? `${wanted} is already a saved website. To fill these accounts there, save them under ${wanted}, then delete ${website.name}.`
          : code === 'INVALID_INPUT'
            ? `The extension can’t match “${wanted}”. Enter a web address like github.com, or an IP address.`
            : message
      )
      // A refused suggestion opens the field with it, to correct.
      if (!typing) {
        setAddress(wanted)
        setTyping(true)
      }
      return
    }
    // The row goes: the list comes back without it.
    queryClient.setQueryData(UNMATCHED_QUERY, result.data)
    void refreshVault(queryClient)
    toast.success(`${website.name} is now ${wanted}`)
  }

  return (
    <li className="px-4 py-2.5">
      <div className="flex items-center gap-3">
        <SiteTile name={website.name} size="sm" className="size-7 rounded-[8px] text-[12px]" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] text-heading">{website.name}</p>
          <p className="text-[12px] text-muted-foreground">{plural(website.accounts, 'account')}</p>
        </div>
        {!typing && website.suggestion && (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={saving}
              onClick={() => {
                setFocus(true)
                setTyping(true)
              }}
            >
              Type another
            </Button>
            <Button size="sm" disabled={saving} onClick={() => void save(website.suggestion ?? '')}>
              {saving && <Spinner size={13} />}
              Use {website.suggestion}
            </Button>
          </>
        )}
      </div>
      {typing && (
        <form
          className="mt-2 flex items-end gap-2 pl-10"
          onSubmit={(event) => {
            event.preventDefault()
            void save(address)
          }}
        >
          <div className="min-w-0 flex-1 space-y-1">
            <label htmlFor={id} className="text-[12px] font-medium text-heading">
              Address of {website.name}
            </label>
            <Input
              id={id}
              value={address}
              autoFocus={focus}
              placeholder="github.com or 192.168.1.1"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
              onChange={(event) => {
                setAddress(event.target.value)
                setError(null)
              }}
              className="h-8 text-[13px]"
            />
          </div>
          {website.suggestion && (
            <Button
              size="md"
              variant="ghost"
              disabled={saving}
              onClick={() => {
                setTyping(false)
                setError(null)
              }}
            >
              Cancel
            </Button>
          )}
          <Button type="submit" size="md" variant="primary" disabled={saving || !address.trim()}>
            {saving && <Spinner size={13} />}
            Save address
          </Button>
        </form>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-1.5 pl-10 text-[12.5px] leading-relaxed text-destructive">
          {error}
        </p>
      )}
    </li>
  )
}

/** What the extension filled since the unlock; fills on another site stand out. */
function RecentFills({ recent }: { recent: RecentFill[] }) {
  const crossSite = recent.some((fill) => fill.crossSite)
  return (
    <section className="space-y-2">
      <h3 className="text-[13px] font-semibold text-heading">Recent fills</h3>
      {recent.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          Nothing filled since the vault was unlocked. Each fill shows here, so you can spot one you didn’t make.
        </p>
      ) : (
        <>
          <ul className="divide-y rounded-xl border">
            {recent.map((fill, i) => (
              <li key={`${fill.at}-${i}`} className="px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <p className="min-w-0 flex-1 truncate text-[13.5px] text-heading">
                    {fill.what === 'code' ? 'Code for ' : ''}
                    {fill.account}
                  </p>
                  {fill.crossSite && (
                    <span className="shrink-0 rounded-md bg-warning/12 px-1.5 py-px text-[11.5px] font-medium text-warning">
                      Other site
                    </span>
                  )}
                </div>
                <p className="text-[12px] text-muted-foreground">
                  On {fill.site} · {fill.browser} · {ago(fill.at)}
                </p>
              </li>
            ))}
          </ul>
          {crossSite && (
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              <span className="font-medium text-warning">Other site</span>: filled on a page this login isn’t saved
              for, after you confirmed it in the extension.
            </p>
          )}
        </>
      )}
    </section>
  )
}
