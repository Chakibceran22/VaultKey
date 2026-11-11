#!/usr/bin/env node
// Registers the DEV bridge (src-tauri/target/debug/vaultkey-bridge) with the Chromium
// browsers installed for this user, so the dev extension can reach the dev app.
// Only the dev extension's ID (dev-key.json) is allowed to start it. Release
// registration is the app's job (plans/06, register.rs, M1).
//
//   node scripts/register-dev-host.mjs            # register
//   node scripts/register-dev-host.mjs --remove   # undo
//
// Per-user locations only: no admin rights, nothing outside your home folder (and,
// on Windows, HKCU).

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOST = 'com.chakibceran22.vaultkey.dev'
const here = dirname(fileURLToPath(import.meta.url))
const remove = process.argv.includes('--remove')
const { extensionId } = JSON.parse(readFileSync(join(here, '..', 'dev-key.json'), 'utf8'))
const os = platform()
const bridge = resolve(here, '..', '..', 'src-tauri', 'target', 'debug', os === 'win32' ? 'vaultkey-bridge.exe' : 'vaultkey-bridge')

const manifest = {
  name: HOST,
  description: 'VaultKey browser bridge (dev)',
  path: bridge,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${extensionId}/`],
}
const text = `${JSON.stringify(manifest, null, 2)}\n`

/** Each browser's user folder, and its NativeMessagingHosts folder inside. */
function unixTargets() {
  const home = homedir()
  const base =
    os === 'darwin'
      ? join(home, 'Library', 'Application Support')
      : process.env.XDG_CONFIG_HOME?.startsWith('/')
        ? process.env.XDG_CONFIG_HOME
        : join(home, '.config')
  const browsers =
    os === 'darwin'
      ? {
          Brave: 'BraveSoftware/Brave-Browser',
          Chrome: 'Google/Chrome',
          Edge: 'Microsoft Edge',
          Chromium: 'Chromium',
          Vivaldi: 'Vivaldi',
          Arc: 'Arc/User Data',
        }
      : {
          Brave: 'BraveSoftware/Brave-Browser',
          Chrome: 'google-chrome',
          Edge: 'microsoft-edge',
          Chromium: 'chromium',
          Vivaldi: 'vivaldi',
        }
  return Object.entries(browsers).map(([name, folder]) => ({
    name,
    profile: join(base, folder),
    file: join(base, folder, 'NativeMessagingHosts', `${HOST}.json`),
  }))
}

function runUnix() {
  let touched = 0
  for (const target of unixTargets()) {
    // Only browsers that are installed (their user folder exists).
    if (!existsSync(target.profile)) continue
    if (remove) {
      if (existsSync(target.file)) {
        rmSync(target.file)
        console.log(`removed  ${target.name}: ${target.file}`)
        touched++
      }
      continue
    }
    mkdirSync(dirname(target.file), { recursive: true })
    writeFileSync(target.file, text)
    console.log(`wrote    ${target.name}: ${target.file}`)
    touched++
  }
  return touched
}

function runWindows() {
  const appData = process.env.APPDATA
  if (!appData) throw new Error('APPDATA is not set')
  const file = join(appData, 'vaultkey-dev', 'native-messaging', `${HOST}.json`)
  // Brave gets its own key and Chrome's: which one it reads on Windows is to be checked
  // on a real install (plans/07, risks). Both point at the same manifest.
  const keys = {
    Chrome: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST}`,
    Brave: `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${HOST}`,
    Edge: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST}`,
    Chromium: `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST}`,
  }
  if (remove) {
    for (const [name, key] of Object.entries(keys)) {
      try {
        execFileSync('reg', ['delete', key, '/f'], { stdio: 'ignore' })
        console.log(`removed  ${name}: ${key}`)
      } catch {
        // Not registered for that browser.
      }
    }
    rmSync(file, { force: true })
    return 1
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  console.log(`wrote    ${file}`)
  for (const [name, key] of Object.entries(keys)) {
    execFileSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', file, '/f'], { stdio: 'ignore' })
    console.log(`set      ${name}: ${key}`)
  }
  return 1
}

const touched = os === 'win32' ? runWindows() : runUnix()
if (!touched) {
  console.log(remove ? 'Nothing to remove.' : 'No Chromium browser found for this user (Brave, Chrome, Edge, Chromium, Vivaldi, Arc).')
} else if (!remove) {
  console.log(`\nAllowed extension: chrome-extension://${extensionId}/`)
  if (!existsSync(bridge)) {
    console.log(`\nThe bridge isn't built yet. Build it with:\n  cd src-tauri && cargo build -p vaultkey-bridge`)
  }
}
