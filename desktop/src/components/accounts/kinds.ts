/**
 * The words and icons for each kind of second step and device, in one place so
 * the account page, the forms, the devices page and the search all agree.
 */
import {
  BellRinging,
  ChatText,
  ClockCountdown,
  DeviceMobile,
  DeviceTablet,
  Devices,
  EnvelopeSimple,
  Fingerprint,
  Key,
  Laptop,
  Lifebuoy
} from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'
import type { DeviceKind, FactorKind } from '@renderer/shared/contracts'

export interface FactorMeta {
  /** "Authenticator app" */
  name: string
  icon: Icon
  /** One line under the choice, saying what it is. */
  about: string
  /** The free-text detail: its field label and example. Null when the kind has none. */
  label: { field: string; placeholder: string } | null
  /** Whether it lives on a device, and how to ask for it. */
  device: string | null
  /** Its secret part: none, optional (setup key) or required (recovery codes). */
  secret: 'none' | 'optional' | 'required'
}

export const FACTOR_KINDS: FactorKind[] = [
  'authenticator',
  'passkey',
  'security_key',
  'sms',
  'email',
  'prompt',
  'recovery_codes'
]

export const FACTORS: Record<FactorKind, FactorMeta> = {
  authenticator: {
    name: 'Authenticator app',
    icon: ClockCountdown,
    about: 'Six-digit codes from an app. Save the setup key to see the codes here too.',
    label: { field: 'App', placeholder: 'Google Authenticator, 1Password, Authy…' },
    device: 'On device',
    secret: 'optional'
  },
  passkey: {
    name: 'Passkey',
    icon: Fingerprint,
    about: 'Signs in with Touch ID, Face ID or a phone, no password typed.',
    label: { field: 'Saved in', placeholder: 'iCloud Keychain, Google Password Manager…' },
    device: 'On device',
    secret: 'none'
  },
  security_key: {
    name: 'Security key',
    icon: Key,
    about: 'A hardware key such as a YubiKey, plugged in or tapped.',
    label: { field: 'Note', placeholder: 'Registered as “Backup key”' },
    device: 'Key',
    secret: 'none'
  },
  sms: {
    name: 'Text message',
    icon: ChatText,
    about: 'Codes sent by SMS to a phone number.',
    label: { field: 'Phone number', placeholder: '+33 6 12 34 56 78' },
    device: null,
    secret: 'none'
  },
  email: {
    name: 'Email code',
    icon: EnvelopeSimple,
    about: 'Codes or links sent to an email address.',
    label: { field: 'Address', placeholder: 'you@example.com' },
    device: null,
    secret: 'none'
  },
  prompt: {
    name: 'Sign-in prompt',
    icon: BellRinging,
    about: 'Approve the sign-in on another device, like GitHub Mobile or a Google prompt.',
    label: { field: 'App', placeholder: 'GitHub Mobile, Gmail app…' },
    device: 'On device',
    secret: 'none'
  },
  recovery_codes: {
    name: 'Recovery codes',
    icon: Lifebuoy,
    about: 'One-time codes for when the other steps are lost. Kept encrypted.',
    label: { field: 'Also kept', placeholder: 'Printed, in the drawer' },
    device: null,
    secret: 'required'
  }
}

export const DEVICE_KINDS: DeviceKind[] = ['phone', 'computer', 'tablet', 'security_key', 'other']

export const DEVICES: Record<DeviceKind, { name: string; icon: Icon }> = {
  phone: { name: 'Phone', icon: DeviceMobile },
  computer: { name: 'Computer', icon: Laptop },
  tablet: { name: 'Tablet', icon: DeviceTablet },
  security_key: { name: 'Security key', icon: Key },
  other: { name: 'Other', icon: Devices }
}
