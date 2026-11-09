// Applies the saved theme before React mounts, so there is no flash of the wrong mode.
// A separate file (not an inline <script>) so the strict CSP needs no exception.
;(function () {
  try {
    var stored = localStorage.getItem('vaultkey-theme')
    var dark =
      stored === 'dark' ||
      (stored !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.classList.toggle('dark', dark)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  } catch (e) {
    // storage blocked: fall back to the stylesheet default (light)
  }
})()
