import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const host = process.env.TAURI_DEV_HOST

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Same alias the Electron renderer used, so imports are unchanged.
      '@renderer': fileURLToPath(new URL('./src', import.meta.url))
    }
  },

  // A desktop app: the bundle loads from local disk, so one ~700 kB chunk costs
  // milliseconds. Splitting it would only add round-trips.
  build: { chunkSizeWarningLimit: 1000 },

  // Pre-bundle every Base UI entry point at startup. Discovered late (e.g. tabs on
  // the project page), Vite bundles them in a second pass with their own copy of
  // React, which breaks hooks ("Invalid hook call") until a manual reload.
  optimizeDeps: {
    // Scan from the app's own page only. `extension/` (the browser extension, a separate
    // WXT build with its own `@/` alias) sits under this root too; scanning its pages
    // fails, and a failed scan skips this pre-bundling.
    entries: ['index.html'],
    include: [
      '@base-ui/react/alert-dialog',
      '@base-ui/react/dialog',
      '@base-ui/react/menu',
      '@base-ui/react/tabs',
      '@base-ui/react/toast',
      '@base-ui/react/tooltip',
      'framer-motion',
      '@phosphor-icons/react'
    ]
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`, and the browser extension (built by WXT)
      ignored: ['**/src-tauri/**', '**/extension/**']
    }
  }
}))
