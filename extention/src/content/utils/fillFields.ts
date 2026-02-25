import { EMAIL_SELECTORS, PASSWORD_SELECTORS } from "./selectorConfig"

export const fillFields = (email: string, password: string) => {
    const emailInput = document.querySelector(
        EMAIL_SELECTORS
    ) as HTMLInputElement

  const passwordInput = document.querySelector(
    PASSWORD_SELECTORS
  ) as HTMLInputElement
    if (!emailInput || !passwordInput) return
      emailInput.value = email
    passwordInput.value = password
    const triggerEvents = (input: HTMLInputElement) => {
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }))
  }

  triggerEvents(emailInput)
  triggerEvents(passwordInput)
    console.log('[VaultKey] Fields filled!')




}