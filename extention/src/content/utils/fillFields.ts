import { EMAIL_SELECTORS, PASSWORD_SELECTORS } from "./selectorConfig"

export const fillFields = (email: string, password: string) => {
  const emailInput = document.querySelector(EMAIL_SELECTORS) as HTMLInputElement
  const passwordInput = document.querySelector(PASSWORD_SELECTORS) as HTMLInputElement

  if (!emailInput || !passwordInput) return

  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  )?.set

  // set email
  nativeInputValueSetter?.call(emailInput, email)
  emailInput.dispatchEvent(new Event('input', { bubbles: true }))

  // set password
  nativeInputValueSetter?.call(passwordInput, password)
  passwordInput.dispatchEvent(new Event('input', { bubbles: true }))

  console.log('[VaultKey] Fields filled!')
}