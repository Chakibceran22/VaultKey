// "Continue with Google" buttons on a site's own login page (plans/04, "Signs in with").
// Found by what they say (English and French), or by where they send you: a sign-in
// address that names the provider (accounts.google.com/o/oauth2, appleid.apple.com/auth,
// login.microsoftonline.com, github.com/login/oauth…, or the site's own /auth/google),
// including Google's sign-in iframe (accounts.google.com/gsi/). In the content script's idle
// scan: kept small, and it looks at a bounded number of elements.

/** "Continue with", "Sign in with", "Se connecter avec", "Continuer avec"… (`\s*`: a button
 * made of two spans reads "Continue withGoogle"). */
const SAYS = '(?:continue|sign\\s*in|log\\s*in|sign\\s*up|se\\s*connecter|connexion|continuer|s.inscrire)\\s*(?:with|using|via|avec)\\s*'
/** An address that starts a sign-in. */
const AUTH = /oauth|\/auth\b|sso|log_?in|sign_?in|openid|\/gsi\/|\/ap\/oa/i
const CANDIDATES = 'a[href],button,[role=button],input[type=submit],form[action],iframe[src*="/gsi/"]'
/** Login pages are small: past this many elements, the rest isn't looked at. */
const MAX_LOOKED_AT = 400

/**
 * The page's sign-in buttons for `hints` (provider id → the badge's text): [button, text],
 * the first button for each. A form that posts to a provider gives its button. With `null`:
 * any sign-in button at all (before asking VaultKey which providers you use here).
 */
export function signInButtons(doc: Document, hints: ReadonlyMap<string, string> | null): [Element, string][] {
  const tests: [string, RegExp, RegExp][] = hints
    ? [...hints].flatMap(([provider, text]) => {
        // The provider's name: "google"; for a domain, its first label ("okta.com": "okta").
        const word = provider === 'x' ? 'x\\b|twitter' : (provider.split('.')[0] ?? '').replace(/[^\w-]/g, '')
        return word ? [[text, new RegExp(`${SAYS}(?:${word})\\b`, 'i'), new RegExp(`\\b(?:${word})`, 'i')] as [string, RegExp, RegExp]] : []
      })
    : [['', new RegExp(`${SAYS}\\w`, 'i'), /oauth|\/gsi\//i]]
  const found = new Map<string, Element>()
  let count = 0
  for (const element of doc.querySelectorAll(CANDIDATES)) {
    if (found.size === tests.length || ++count > MAX_LOOKED_AT) break
    const url = element.getAttribute('href') ?? element.getAttribute('action') ?? element.getAttribute('src') ?? ''
    const text = (element.getAttribute('aria-label') || element.textContent || (element as HTMLInputElement).value || '').slice(0, 80)
    for (const [key, says, names] of tests) {
      if (!found.has(key) && (says.test(text) || (AUTH.test(url) && names.test(url)))) {
        found.set(key, element.matches('form') ? (element.querySelector('button,[type=submit]') ?? element) : element)
      }
    }
  }
  return [...found].map(([key, element]) => [element, key])
}
