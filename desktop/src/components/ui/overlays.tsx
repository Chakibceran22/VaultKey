/**
 * Overlays (L3): the modal every create/edit form opens in, and the row menu.
 * Both trap focus, close on Esc and restore focus to what opened them (Base UI).
 * One modal at a time: a form never opens another modal on top of itself.
 */
import { Dialog } from '@base-ui/react/dialog'
import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import { DotsThree, X } from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { cn } from '@renderer/lib/utils'
import { IconButton } from './icon-button'

const widths = { md: 'w-[min(480px,calc(100vw-2rem))]', lg: 'w-[min(560px,calc(100vw-2rem))]' } as const

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  size = 'md',
  closable = true,
  children
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  size?: keyof typeof widths
  /** False for a step that must be finished: no close button (and the caller ignores Esc). */
  closable?: boolean
  /** A <form> made of <ModalBody> and <ModalFooter>. */
  children: ReactNode
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="backdrop-motion fixed inset-0 z-[200] bg-(--scrim)" />
        <Dialog.Popup
          className={cn(
            'glass-strong panel-motion modal-frame fixed left-1/2 z-[200] flex -translate-x-1/2 flex-col overflow-hidden rounded-2xl text-popover-foreground outline-none',
            widths[size]
          )}
        >
          <header className="flex items-start gap-3 px-6 pt-5 pb-1">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-[17px] leading-snug font-semibold tracking-[-0.01em] text-heading">
                {title}
              </Dialog.Title>
              {description && (
                <Dialog.Description className="mt-1 text-[13.5px] leading-relaxed text-muted-foreground">
                  {description}
                </Dialog.Description>
              )}
            </div>
            {closable && (
              <Dialog.Close render={<IconButton label="Close" shortcut="Esc" size="icon-sm" className="-mt-0.5 -mr-2" />}>
                <X size={15} />
              </Dialog.Close>
            )}
          </header>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function ModalBody({ children }: { children: ReactNode }) {
  return <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pt-4 pb-6">{children}</div>
}

export function ModalFooter({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-end gap-2 border-t bg-secondary/30 px-6 py-3.5 dark:bg-white/[0.02]">
      {children}
    </div>
  )
}

/** A row's "more actions" menu. */
export function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <MenuPrimitive.Root>
      <MenuPrimitive.Trigger render={<IconButton label={label} size="icon-sm" />}>
        <DotsThree size={18} weight="bold" />
      </MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner side="bottom" align="end" sideOffset={6} className="z-[100] outline-none">
          <MenuPrimitive.Popup className="glass-strong min-w-[12rem] origin-(--transform-origin) rounded-xl p-1 text-[13.5px] text-popover-foreground outline-none transition-[opacity,scale] duration-150 ease-smooth data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.96] data-starting-style:opacity-0 motion-reduce:data-starting-style:scale-100">
            {children}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  )
}

export function RowMenuItem({
  icon: ItemIcon,
  tone = 'default',
  onClick,
  children
}: {
  icon: Icon
  tone?: 'default' | 'destructive'
  onClick: () => void
  children: ReactNode
}) {
  return (
    <MenuPrimitive.Item
      onClick={onClick}
      className={cn(
        'flex h-8 cursor-default items-center gap-2.5 rounded-lg px-2.5 outline-none select-none data-highlighted:bg-primary/10 data-highlighted:text-heading dark:data-highlighted:bg-primary/15',
        tone === 'destructive' &&
          'text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive dark:data-highlighted:bg-destructive/15'
      )}
    >
      <ItemIcon size={15} className="shrink-0" />
      {children}
    </MenuPrimitive.Item>
  )
}

export function RowMenuSeparator() {
  return <MenuPrimitive.Separator className="mx-2 my-1 h-px bg-border" />
}
