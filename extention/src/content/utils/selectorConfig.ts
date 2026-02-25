   export const EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[name*="email"]',
  'input[name*="username"]',
  'input[name*="user"]',
  'input[name*="login"]',
  'input[id*="email"]',
  'input[id*="username"]',
  'input[autocomplete="email"]',
  'input[autocomplete="username"]',
].join(',')

export const PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[autocomplete="current-password"]',
].join(',')