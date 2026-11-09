/**
 * Toasts (DevNotes' toast stack): call toast.success() / toast.error() from
 * anywhere; <Toaster /> (components/ui/toaster.tsx), mounted once, shows them.
 *
 * Kept apart from the component on purpose: a file that exports a React
 * component must export only components, or fast refresh can't update it.
 */
import { Toast } from '@base-ui/react/toast'

type Tone = 'default' | 'success' | 'error'

/** Shared by toast() and <Toaster />. */
export const toastManager = Toast.createToastManager()

function show(title: string, tone: Tone): string {
  return toastManager.add({
    title,
    type: tone,
    priority: tone === 'error' ? 'high' : 'low',
    timeout: tone === 'error' ? 6000 : 3500
  })
}

export const toast = {
  message: (title: string) => show(title, 'default'),
  success: (title: string) => show(title, 'success'),
  error: (title: string) => show(title, 'error')
}
