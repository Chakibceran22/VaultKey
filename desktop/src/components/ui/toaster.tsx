/**
 * DevNotes' toast stack: glass cards bottom-right, newest in front and the rest
 * peeking above it; hovering fans them out. Auto-dismiss pauses while hovered,
 * errors are announced assertively, swipe right/down dismisses.
 */
import { Toast } from '@base-ui/react/toast'
import { CheckCircle, WarningCircle, X } from '@phosphor-icons/react'
import { cn } from '@renderer/lib/utils'
import { toastManager } from '@renderer/lib/toast'
import './toast.css'

export function Toaster() {
  return (
    <Toast.Provider toastManager={toastManager} limit={3}>
      <Toast.Portal>
        <Toast.Viewport className="toast-viewport">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  )
}

function ToastList() {
  const { toasts } = Toast.useToastManager()
  return toasts.map((item) => {
    const isError = item.type === 'error'
    const isSuccess = item.type === 'success'
    return (
      <Toast.Root
        key={item.id}
        toast={item}
        className={cn(
          'toast glass-strong rounded-2xl outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          isError && 'border-destructive/35'
        )}
      >
        <Toast.Content className="toast-content flex items-start gap-3 overflow-hidden py-3 pr-2.5 pl-3.5">
          {isError ? (
            <WarningCircle size={18} weight="fill" className="mt-px shrink-0 text-destructive" aria-hidden="true" />
          ) : isSuccess ? (
            <CheckCircle size={18} weight="fill" className="mt-px shrink-0 text-primary" aria-hidden="true" />
          ) : null}
          <div className="min-w-0 flex-1 py-px">
            <Toast.Title className="text-[14px] leading-snug font-medium text-heading" />
            <Toast.Description className="mt-0.5 line-clamp-3 text-[13px] leading-snug text-muted-foreground empty:hidden" />
          </div>
          <Toast.Close
            aria-label="Dismiss"
            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <X size={13} />
          </Toast.Close>
        </Toast.Content>
      </Toast.Root>
    )
  })
}
