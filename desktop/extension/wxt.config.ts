import { defineConfig } from 'wxt'
import { buildManifest } from './lib/manifest'

export default defineConfig({
  // Loaded by hand (Load unpacked): branded Chrome and Brave ignore --load-extension, and
  // the dev bridge must be registered in your own browser profile, not a throwaway one.
  webExt: { disabled: true },
  manifest: ({ mode }) => buildManifest(mode),
})
