import { create } from 'zustand'
import type { StagedList } from '@renderer/shared/contracts'

/**
 * The project files dropped onto the window go into (set by the project page), and
 * the files just dropped, already waiting in its upload dialog (set by the frame,
 * taken by the project page, which opens the dialog).
 */
export const useDropTarget = create<{
  target: { projectId: number; name: string } | null
  setTarget: (target: { projectId: number; name: string } | null) => void
  dropped: StagedList | null
  setDropped: (dropped: StagedList | null) => void
}>((set) => ({
  target: null,
  setTarget: (target) => set({ target }),
  dropped: null,
  setDropped: (dropped) => set({ dropped })
}))
