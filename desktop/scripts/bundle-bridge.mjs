#!/usr/bin/env node
/**
 * Builds the browser bridge (`vaultkey-bridge`, src-tauri/bridge/) and puts it where
 * Tauri's `bundle.externalBin` looks for it:
 *
 *   src-tauri/binaries/vaultkey-bridge-<target triple>[.exe]
 *
 * Tauri checks for that file on every build of the app, not only when bundling: its build
 * script (tauri-build) copies it next to the app's executable, where VaultKey looks for the
 * bridge, and fails the build if it's missing. That includes `pnpm tauri dev` and a plain
 * `cargo test`, so it has to exist before the app compiles:
 *
 *   pnpm bridge:dev       a debug bridge: before `pnpm tauri dev` (beforeDevCommand), or once
 *                         before `cargo test` in a fresh checkout
 *   pnpm bridge:release   a release bridge: before `pnpm tauri build` (beforeBuildCommand)
 *
 * The bridge's flavor must match the app's: a debug bridge is the dev bridge (dev socket,
 * dev host name), so every `tauri build`, even `--debug`, bundles a release one.
 *
 * The target is `--target <triple>`, else TAURI_ENV_TARGET_TRIPLE (the Tauri CLI sets it
 * for these commands), else this machine's. `universal-apple-darwin` builds both Mac
 * architectures and joins them with lipo; the single-architecture files stay, because
 * Tauri builds the app once per architecture and checks for each.
 *
 * Cargo runs with -j 2 (CARGO_BUILD_JOBS overrides it), to keep the laptop cool.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC_TAURI = join(DESKTOP, 'src-tauri')
const BINARIES = join(SRC_TAURI, 'binaries')
const NAME = 'vaultkey-bridge'
const UNIVERSAL = 'universal-apple-darwin'
const MAC_ARCHES = ['aarch64-apple-darwin', 'x86_64-apple-darwin']

function fail(message) {
  console.error(`bundle-bridge: ${message}`)
  process.exit(1)
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: SRC_TAURI, stdio: 'inherit' })
  if (result.error) fail(`couldn't run ${command}: ${result.error.message}`)
  if (result.status !== 0) fail(`\`${command} ${args.join(' ')}\` failed`)
}

function hostTriple() {
  const result = spawnSync('rustc', ['-vV'], { encoding: 'utf8' })
  const host = /^host: (\S+)$/m.exec(result.stdout ?? '')?.[1]
  if (!host) fail('couldn’t read this machine’s target from `rustc -vV`. Is Rust installed?')
  return host
}

const exe = (triple) => (triple.includes('windows') ? '.exe' : '')

function parseArgs(argv) {
  const options = { release: false, target: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--release') options.release = true
    else if (argv[i] === '--target' && argv[i + 1]) options.target = argv[++i]
    else fail(`unknown argument "${argv[i]}". Usage: bundle-bridge.mjs [--release] [--target <triple>]`)
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const host = hostTriple()
const target = options.target || process.env.TAURI_ENV_TARGET_TRIPLE || host
const profile = options.release ? 'release' : 'debug'
const jobs = process.env.CARGO_BUILD_JOBS || '2'
const targetDir = process.env.CARGO_TARGET_DIR ? resolve(SRC_TAURI, process.env.CARGO_TARGET_DIR) : join(SRC_TAURI, 'target')

/** Builds the bridge for `triple` and returns the path cargo wrote it to. */
function build(triple) {
  const args = ['build', '-p', NAME, '-j', jobs]
  if (options.release) args.push('--release')
  // This machine's own build goes to target/<profile>, where the app's dev build is, and
  // shares its cache. Another target gets target/<triple>/<profile>, like `tauri build --target`.
  if (triple !== host) args.push('--target', triple)
  run('cargo', args)
  const built = join(targetDir, ...(triple === host ? [] : [triple]), profile, NAME + exe(triple))
  if (!existsSync(built)) fail(`cargo finished but ${built} isn’t there`)
  return built
}

/**
 * Moves `temp` to `dest`, unless `dest` already holds the same bytes: then it's left alone,
 * date included, so Tauri doesn't rebuild the app for nothing. The rename means a build
 * running at the same time never sees half a file.
 */
function settle(temp, dest) {
  if (existsSync(dest) && readFileSync(dest).equals(readFileSync(temp))) {
    rmSync(temp)
    return
  }
  chmodSync(temp, 0o755)
  renameSync(temp, dest)
}

function place(source, triple) {
  const dest = join(BINARIES, `${NAME}-${triple}${exe(triple)}`)
  const temp = `${dest}.partial`
  copyFileSync(source, temp)
  settle(temp, dest)
  return dest
}

mkdirSync(BINARIES, { recursive: true })
let placed
if (target === UNIVERSAL) {
  if (process.platform !== 'darwin') fail('a universal macOS bridge can only be built on macOS (it needs lipo).')
  const parts = MAC_ARCHES.map((triple) => place(build(triple), triple))
  placed = join(BINARIES, `${NAME}-${UNIVERSAL}`)
  const temp = `${placed}.partial`
  run('lipo', ['-create', '-output', temp, ...parts])
  settle(temp, placed)
} else {
  placed = place(build(target), target)
}
console.log(`bundle-bridge: ${relative(DESKTOP, placed)} (${profile})`)
