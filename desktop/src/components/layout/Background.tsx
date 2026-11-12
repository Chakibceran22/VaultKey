import { useId, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Select } from '@renderer/components/ui/controls'
import { Spinner } from '@renderer/components/ui/misc'
import { ModalBody } from '@renderer/components/ui/overlays'
import { plural } from '@renderer/hooks/use-vault'
import { api } from '@renderer/lib/api'
import { IS_MAC } from '@renderer/lib/dom'
import { unwrap } from '@renderer/lib/ipc'
import { toast } from '@renderer/lib/toast'
import type { BackgroundSettings } from '@renderer/shared/contracts'

export const BACKGROUND_QUERY = ['background-settings'] as const

/** The auto-lock choices (the app takes 1–60). */
const MINUTES = [1, 2, 5, 10, 15, 30, 60]

/** Linux has no tray icon yet (background.rs), so closing the window always locks there. */
const IS_LINUX = typeof navigator !== 'undefined' && /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent)
/** Where VaultKey's icon sits while the window is closed (macOS and Windows). */
export const TRAY = IS_MAC ? 'menu bar' : 'system tray'

export function useBackgroundSettings() {
  return useQuery({ queryKey: BACKGROUND_QUERY, queryFn: async () => unwrap(await api.backgroundSettings()) })
}

/**
 * Settings → Background & auto-lock (src-tauri/src/background.rs): whether closing the
 * window keeps VaultKey running for the extension, and how soon it locks itself. Each
 * change is saved and applied at once.
 */
export function BackgroundPanel() {
  const queryClient = useQueryClient()
  const settings = useBackgroundSettings()
  const [saving, setSaving] = useState(false)
  const selectId = useId()

  async function save(next: BackgroundSettings, previous: BackgroundSettings): Promise<void> {
    // The control moves at once; a refusal puts it back.
    queryClient.setQueryData(BACKGROUND_QUERY, next)
    setSaving(true)
    const result = await api.setBackgroundSettings(next)
    setSaving(false)
    if (result.ok) {
      queryClient.setQueryData(BACKGROUND_QUERY, result.data)
    } else {
      queryClient.setQueryData(BACKGROUND_QUERY, previous)
      toast.error(`Couldn’t save the setting: ${result.error.message}`)
    }
  }

  const data = settings.data
  // A value set some other way still shows as it is.
  const choices = data && !MINUTES.includes(data.autoLockMinutes) ? [...MINUTES, data.autoLockMinutes].sort((a, b) => a - b) : MINUTES

  return (
    <ModalBody>
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        {IS_LINUX
          ? 'VaultKey locks itself when you stop using it.'
          : 'VaultKey can stay open after you close its window, so the browser extension keeps filling. It locks itself when you stop using it.'}
      </p>
      {settings.isPending ? (
        <div className="flex justify-center py-8 text-muted-foreground">
          <Spinner />
        </div>
      ) : settings.isError || !data ? (
        <p className="text-[13.5px] text-destructive">
          {settings.error instanceof Error ? settings.error.message : 'Something went wrong.'}
        </p>
      ) : (
        <>
          {IS_LINUX ? (
            <p className="rounded-xl border px-4 py-3.5 text-[12.5px] leading-relaxed text-muted-foreground">
              On Linux, closing the window locks the vault: VaultKey has no tray icon there yet to bring a hidden
              window back.
            </p>
          ) : (
            <section className="rounded-xl border px-4 py-3.5">
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={data.keepRunning}
                  disabled={saving}
                  onChange={(event) => void save({ ...data, keepRunning: event.target.checked }, data)}
                  className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary"
                />
                <span className="min-w-0">
                  <span className="block text-[14px] font-medium text-heading">
                    Keep VaultKey running when the window is closed
                  </span>
                  <span className="mt-0.5 block text-[12.5px] leading-relaxed text-muted-foreground">
                    {data.keepRunning
                      ? `Closing the window hides it: VaultKey stays in the ${TRAY}, and the extension keeps filling until it locks. Open, Lock and Quit are there.`
                      : 'Closing the window locks the vault, and the extension can’t fill until you open VaultKey and unlock it again.'}
                  </span>
                </span>
              </label>
            </section>
          )}

          <section className="flex items-center gap-4 rounded-xl border px-4 py-3.5">
            <div className="min-w-0 flex-1">
              <label htmlFor={selectId} className="text-[14px] font-medium text-heading">
                Lock after
              </label>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
                without use. Use is an unlock, activity in this window, or a fill from the extension.
              </p>
            </div>
            <Select
              id={selectId}
              value={data.autoLockMinutes}
              disabled={saving}
              onChange={(event) => void save({ ...data, autoLockMinutes: Number(event.target.value) }, data)}
              className="w-36 shrink-0"
            >
              {choices.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {plural(minutes, 'minute')}
                </option>
              ))}
            </Select>
          </section>

          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            {IS_MAC
              ? 'It also locks at once when your Mac goes to sleep or the screen locks.'
              : 'It doesn’t notice sleep or the screen locking on this system yet: time asleep counts as time without use, so after a longer sleep it locks within 30 seconds of waking.'}
          </p>
        </>
      )}
    </ModalBody>
  )
}
