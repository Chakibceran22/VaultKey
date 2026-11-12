#!/usr/bin/env node
/**
 * VaultKey data tools. Every command only ever READS your real vault; it is
 * never written, moved or locked. Copies are verified byte-for-byte.
 *
 *   pnpm vault:snapshot                  copy your real vault into the dev vault, so
 *                                        `pnpm tauri dev` shows your real data
 *   pnpm vault:snapshot --from <file>    put a vault file from elsewhere (another
 *                                        computer, a backup) into the dev vault
 *   pnpm vault:rehearse                  run the app's pending migrations on a
 *                                        throwaway copy of your real vault and prove
 *                                        no row is lost or changed
 *   pnpm vault:where                     show where every vault lives
 *
 * The real vault is where the Electron app kept it (src-tauri/src/paths.rs):
 *   macOS    ~/Library/Application Support/vaultkey/vaultkey.sqlite3
 *   Windows  %APPDATA%\vaultkey\vaultkey.sqlite3
 *   Linux    ~/.config/vaultkey/vaultkey.sqlite3
 * Dev builds use the sibling folder "vaultkey-dev" instead.
 *
 * VAULTKEY_CONFIG_DIR overrides the base folder (used to test this script).
 */
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { homedir, platform, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DB = 'vaultkey.sqlite3'
const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function configDir() {
  if (process.env.VAULTKEY_CONFIG_DIR) return resolve(process.env.VAULTKEY_CONFIG_DIR)
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support')
  if (platform() === 'win32') return process.env.APPDATA
  const xdg = process.env.XDG_CONFIG_HOME
  return xdg && xdg.startsWith('/') ? xdg : join(homedir(), '.config')
}

/** The real vault: the Electron folder name first (see paths.rs). */
function realVault() {
  for (const name of ['vaultkey', 'VaultKey']) {
    const candidate = join(configDir(), name, DB)
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

const devVault = () => join(configDir(), 'vaultkey-dev', DB)

class Refusal extends Error {}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const size = (file) => (existsSync(file) ? statSync(file).size : 0)
const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '')

/** PIDs that have the file open, via lsof (macOS/Linux). null when it can't tell. */
function holders(file) {
  if (!existsSync(file)) return []
  try {
    return execFileSync('lsof', ['-t', '--', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .filter(Boolean)
  } catch (error) {
    if (error.status === 1) return [] // lsof: nobody has it open
    return null // lsof missing (Windows) or failed
  }
}

function assertClosed(file, what, howToClose) {
  const pids = [file, `${file}-wal`].map(holders)
  if (pids.includes(null)) {
    console.warn(`! Couldn't check whether ${what} is in use. Make sure ${howToClose}.`)
    return
  }
  const open = [...new Set(pids.flat())]
  if (open.length) {
    throw new Refusal(`${what} is open in another program (pid ${open.join(', ')}). ${howToClose}, then run this again.`)
  }
}

/**
 * Copies a vault (main file + its write-ahead log, if any) into `targetDir`
 * while nothing has it open, and proves it: the source is byte-identical
 * before and after, and the copy is byte-identical to the source.
 */
function copyVault(source, targetDir) {
  assertClosed(source, 'Your vault', 'Quit VaultKey and the old Electron app (⌘Q)')
  const before = sha256(source)
  mkdirSync(targetDir, { recursive: true, mode: 0o700 })
  const target = join(targetDir, DB)
  copyFileSync(source, target)
  // Uncheckpointed changes (e.g. after a force-quit) live in the WAL: take them too.
  // The -shm index is rebuilt by SQLite and must not be copied.
  if (size(`${source}-wal`) > 0) copyFileSync(`${source}-wal`, `${target}-wal`)
  for (const file of [target, `${target}-wal`]) if (existsSync(file)) chmodSync(file, 0o600)

  if (sha256(source) !== before) throw new Error('The source vault changed while it was being copied. Nothing was harmed; run this again.')
  if (sha256(target) !== before) throw new Error('The copy does not match the source byte-for-byte.')
  return target
}

/** Integrity and counts, read from the COPY with the sqlite3 CLI if it is installed. */
function describe(copy) {
  const result = spawnSync(
    'sqlite3',
    [copy, 'PRAGMA integrity_check;', 'PRAGMA user_version;', 'SELECT COUNT(*) FROM domains;', 'SELECT COUNT(*) FROM credentials;'],
    { encoding: 'utf8' }
  )
  if (result.status !== 0) return null
  const [integrity, version, domains, credentials] = result.stdout.trim().split('\n')
  return { integrity, version, domains, credentials }
}

function snapshot(args) {
  const fromIndex = args.indexOf('--from')
  const source = fromIndex >= 0 ? resolve(args[fromIndex + 1] ?? '') : realVault()
  if (!source || !existsSync(source)) {
    throw new Refusal(fromIndex >= 0 ? `No vault file at ${source}.` : `No real vault found under ${configDir()}.`)
  }
  const dev = devVault()
  const devDir = dirname(dev)
  if (resolve(source) === resolve(dev)) throw new Refusal('That is already the dev vault.')

  assertClosed(dev, 'The dev vault', 'Stop `pnpm tauri dev` (quit the app window)')

  // Keep the current dev vault (and its sidecars) instead of overwriting it.
  let kept = null
  if (existsSync(dev)) {
    kept = join(devDir, 'previous', stamp())
    mkdirSync(kept, { recursive: true, mode: 0o700 })
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(dev + suffix)) renameSync(dev + suffix, join(kept, DB + suffix))
    }
  }

  const copy = copyVault(source, devDir)
  const info = describe(copy)

  console.log(`✓ Copied ${source}`)
  console.log(`      to ${copy}  (${kb(size(source))}, verified byte-for-byte; the original was not modified)`)
  if (info) {
    console.log(`  integrity: ${info.integrity} · schema v${info.version} · ${info.domains} domains · ${info.credentials} credentials`)
  }
  if (kept) console.log(`  Your previous dev vault was kept in ${kept}`)
  console.log('\nNext: `pnpm tauri dev`, then unlock with the master password of the copied vault.')
}

function rehearse() {
  const source = realVault()
  if (!source) throw new Refusal(`No real vault found under ${configDir()}.`)
  // The rehearsal is one of the app's tests, and the app only builds with the browser
  // bridge in src-tauri/binaries/ (Tauri's externalBin): build it first, before any copy.
  const bridge = spawnSync(process.execPath, [join(DESKTOP, 'scripts', 'bundle-bridge.mjs')], { stdio: 'inherit' })
  if (bridge.status !== 0) {
    throw new Refusal('The browser bridge didn’t build, and the app needs it to build. Your real vault was not touched.')
  }
  const workspace = mkdtempSync(join(tmpdir(), 'vaultkey-rehearsal-'))
  try {
    const copy = copyVault(source, workspace)
    console.log(`Rehearsing the migrations on a throwaway copy of ${source}…\n`)
    const run = spawnSync(
      'cargo',
      ['test', '--quiet', '--manifest-path', join(DESKTOP, 'src-tauri', 'Cargo.toml'), 'migration_rehearsal', '--', '--ignored', '--nocapture'],
      { stdio: 'inherit', env: { ...process.env, VAULTKEY_REHEARSAL_DB: copy } }
    )
    if (run.status !== 0) {
      throw new Refusal('The rehearsal FAILED: do not ship this migration. Your real vault was not touched.')
    }
    console.log('\n✓ Safe to ship: the migrations apply to your real data and keep every row. Your real vault was not touched.')
  } finally {
    // The workspace holds a copy of the vault: never leave it behind.
    rmSync(workspace, { recursive: true, force: true })
  }
}

function where() {
  const real = realVault()
  const dev = devVault()
  console.log(`Real vault (installed app): ${real ?? `none yet (would be ${join(configDir(), 'vaultkey', DB)})`}`)
  if (real) console.log(`  backups before migrations: ${join(dirname(real), 'backups')}`)
  console.log(`Dev vault (pnpm tauri dev): ${existsSync(dev) ? dev : `none yet (would be ${dev})`}`)
}

const [command, ...args] = process.argv.slice(2)
try {
  if (command === 'snapshot') snapshot(args)
  else if (command === 'rehearse') rehearse()
  else if (command === 'where') where()
  else {
    console.log('usage: vault-tools.mjs snapshot [--from <file>] | rehearse | where')
    process.exitCode = 2
  }
} catch (error) {
  console.error(`✗ ${error.message}`)
  process.exitCode = 1
}
