import { defineManifest } from '@crxjs/vite-plugin'
import pkg from './package.json'

export default defineManifest({
  manifest_version: 3,
  name: pkg.name,
  version: pkg.version,
  icons: {
    48: 'public/logo.png',
  },
  action: {
    default_icon: {
      48: 'public/logo.png',
    },
    // removed default_popup
  },
  permissions: [
    'sidePanel',
    'storage',
    'tabs',
    'activeTab',
  ],
  content_scripts: [{
    js: ['src/content/main.tsx'],
    matches: ['https://*/*', 'http://localhost/*',   // ← add this
    'http://127.0.0.1/*', ],
  }],
  host_permissions: [
    'http://localhost/*',    // ← add this
    'http://127.0.0.1/*',   // ← and this just in case
  ],
  side_panel: {
    default_path: 'src/sidepanel/index.html',
  },
  background: {
    service_worker: 'src/background.ts'
  }
})