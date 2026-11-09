/** True when a key press is meant for a text field, not for an app shortcut. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
}

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)

/** ⌘ on macOS, Ctrl elsewhere. */
export function isModKey(event: KeyboardEvent): boolean {
  return IS_MAC ? event.metaKey : event.ctrlKey
}

export const MOD = IS_MAC ? '⌘' : 'Ctrl+'

/**
 * True while a modal, confirmation or the search palette is open. Page and app
 * shortcuts stand down then, so nothing opens on top of a form or swaps what it
 * is editing. (Locking with ⌘L still works.)
 */
export function isOverlayOpen(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null
}
