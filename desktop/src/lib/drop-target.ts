import { create } from 'zustand'

/** The project files dropped onto the window go into (set by the project page). */
export const useDropTarget = create<{
  target: { projectId: number; name: string } | null
  setTarget: (target: { projectId: number; name: string } | null) => void
}>((set) => ({
  target: null,
  setTarget: (target) => set({ target })
}))
