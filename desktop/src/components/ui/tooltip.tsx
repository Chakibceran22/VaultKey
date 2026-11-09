import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'
import { cn } from '@renderer/lib/utils'

/** Mounted once at the root: tooltips open after a short hover (or on keyboard
 *  focus), and neighbours then open instantly while you scan. */
export function TooltipProvider({
  delay = 500,
  closeDelay = 0,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return <TooltipPrimitive.Provider delay={delay} closeDelay={closeDelay} {...props} />
}

export const Tooltip = TooltipPrimitive.Root
export const TooltipTrigger = TooltipPrimitive.Trigger

/** A small dark label (macOS help-tag style). Put a shortcut in a <kbd data-slot="kbd">. */
export function TooltipContent({
  className,
  side = 'bottom',
  sideOffset = 6,
  children,
  ...props
}: TooltipPrimitive.Popup.Props & Pick<TooltipPrimitive.Positioner.Props, 'side' | 'sideOffset'>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        collisionPadding={8}
        className="isolate z-[400]"
      >
        <TooltipPrimitive.Popup
          className={cn(
            'flex w-fit max-w-xs origin-(--transform-origin) items-center gap-2 rounded-lg bg-heading/95 px-2 py-1 text-[12px] leading-5 font-medium text-background shadow-[0_4px_16px_-4px_rgb(0_0_0/0.3)] dark:bg-[#2a2d3d] dark:text-heading',
            'transition-[opacity,scale] duration-150 ease-smooth data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-opacity motion-reduce:data-starting-style:scale-100',
            '**:data-[slot=kbd]:font-sans **:data-[slot=kbd]:text-[11.5px] **:data-[slot=kbd]:font-normal **:data-[slot=kbd]:tracking-[0.04em] **:data-[slot=kbd]:opacity-65',
            className
          )}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}
