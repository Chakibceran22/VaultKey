import { useEffect, useRef, useState } from 'react'
import { AlertDialog } from '@base-ui/react/alert-dialog'
import { useQueryClient } from '@tanstack/react-query'
import { isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Button } from '@renderer/components/ui/button'
import { api } from '@renderer/lib/api'
import { unwrap } from '@renderer/lib/ipc'
import { toast } from '@renderer/lib/toast'
import type { PairingEnded, PairingPrompt } from '@renderer/shared/contracts'
import { BRIDGE_QUERY } from './BrowserExtension'

/** "Connect browser" can't be clicked sooner: a dialog that pops up under the cursor
 * mid-click must not take that click as a yes. */
const ARMING_MS = 600

/**
 * "Connect Brave to VaultKey?": a browser asked to pair (src-tauri/src/bridge/mod.rs).
 * The code is derived from both keys, and the extension's popup shows the same one; the
 * name is whatever the asking program says, so the code is what to check. It closes by
 * itself when the request ends without an answer (2 minutes, the browser gave up, the vault
 * locked). Above any other panel, starting on the safe answer.
 */
export function PairingDialog() {
  const queryClient = useQueryClient()
  const [prompt, setPrompt] = useState<PairingPrompt | null>(null)
  const [answering, setAnswering] = useState(false)
  /** Which request's Connect button may be clicked (per request, so a new one never
   * inherits the last one's). */
  const [armedId, setArmedId] = useState<number | null>(null)
  const refuseRef = useRef<HTMLButtonElement>(null)
  /** The request this window answered yes to: its end says whether it worked. */
  const approved = useRef<{ id: number; name: string } | null>(null)

  useEffect(() => {
    if (!isTauri()) return
    const offs: Array<() => void> = []
    let alive = true
    const keep = (off: () => void): void => {
      if (alive) offs.push(off)
      else off()
    }
    listen<PairingPrompt>('bridge://pairing', ({ payload }) => setPrompt(payload)).then(keep, () => {})
    listen<PairingEnded>('bridge://pairing-ended', ({ payload }) => {
      setPrompt((open) => (open?.id === payload.id ? null : open))
      void queryClient.invalidateQueries({ queryKey: BRIDGE_QUERY })
      const mine = approved.current
      if (mine?.id === payload.id) {
        approved.current = null
        if (payload.paired) toast.success(`${mine.name} is connected`)
        else toast.error(`${mine.name} wasn’t connected: it stopped waiting, or the vault locked. Try again from the extension.`)
      }
    }).then(keep, () => {})
    // A request that arrived before this window was listening.
    void api.pendingPairing().then((result) => {
      if (alive && result.ok && result.data) setPrompt(result.data)
    })
    return () => {
      alive = false
      offs.forEach((off) => off())
    }
  }, [queryClient])

  // Each new request starts disarmed.
  const promptId = prompt?.id
  useEffect(() => {
    if (promptId === undefined) return
    const timer = setTimeout(() => setArmedId(promptId), ARMING_MS)
    return () => clearTimeout(timer)
  }, [promptId])

  async function answer(approve: boolean): Promise<void> {
    if (!prompt) return
    const { id, name } = prompt
    setAnswering(true)
    try {
      if (approve) approved.current = { id, name }
      unwrap(await api.answerPairing(id, approve))
    } catch (error) {
      approved.current = null
      toast.error(error instanceof Error ? error.message : 'The pairing request has ended.')
    } finally {
      setAnswering(false)
      // Only this request: a newer one that arrived meanwhile stays on screen.
      setPrompt((open) => (open?.id === id ? null : open))
    }
  }

  const code = prompt ? `${prompt.code.slice(0, 3)} ${prompt.code.slice(3)}` : ''

  return (
    <AlertDialog.Root open={prompt !== null} onOpenChange={(open) => !open && !answering && void answer(false)}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="backdrop-motion fixed inset-0 z-[300] bg-(--scrim)" />
        <AlertDialog.Popup
          initialFocus={refuseRef}
          className="glass-strong panel-motion fixed top-[16vh] left-1/2 z-[300] flex w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 flex-col rounded-2xl p-5 text-popover-foreground outline-none"
        >
          <AlertDialog.Title className="text-[17px] leading-snug font-semibold tracking-[-0.01em] text-heading">
            Connect a browser to VaultKey?
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground">
            “{prompt?.name}” asks to connect. Connect only if you just clicked Connect in the VaultKey extension and
            its popup shows this same code. If you didn’t, click Don’t connect.
          </AlertDialog.Description>
          <p
            aria-label={`Code ${prompt?.code.split('').join(' ') ?? ''}`}
            className="my-5 text-center font-mono text-[32px] font-semibold tracking-[0.12em] text-heading tabular-nums"
          >
            {code}
          </p>
          <div className="flex justify-end gap-2">
            <Button ref={refuseRef} variant="ghost" disabled={answering} onClick={() => void answer(false)}>
              Don’t connect
            </Button>
            <Button
              variant="primary"
              disabled={answering || prompt === null || armedId !== prompt.id}
              onClick={() => void answer(true)}
            >
              Connect browser
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
