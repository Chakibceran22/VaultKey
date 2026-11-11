// Putting a value in a field so the page notices (plans/05, "Filling").
//
// A content script runs in an isolated world: `el.value = …` uses the browser's own value
// setter, not a framework's patched one, which is what React, Vue and Angular need to see
// a change. The input event says it was a replacement, like a paste. If the page's script
// puts the old value back, the value is typed in instead, one character at a time.

function events(el: HTMLInputElement, value: string): void {
  el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: value }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

function type(el: HTMLInputElement, value: string): void {
  el.value = ''
  for (const char of value) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true, composed: true }))
    el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: char, bubbles: true, composed: true, cancelable: true }))
    el.value += char
    el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: char, bubbles: true, composed: true }))
    el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true, composed: true }))
  }
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

/** Fills `el` with `value`; true if the value stayed. */
export async function fillField(el: HTMLInputElement, value: string): Promise<boolean> {
  el.focus()
  el.value = value
  events(el, value)
  // A page script that resets the field does it in the same task or the next one.
  await new Promise((resolve) => setTimeout(resolve, 0))
  if (el.value === value) return true
  el.focus()
  type(el, value)
  await new Promise((resolve) => setTimeout(resolve, 0))
  return el.value === value
}
