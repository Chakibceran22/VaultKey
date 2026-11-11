// The native-messaging host names (src-tauri/bridge/src/address.rs, Flavor::host_name).
// tests/fixtures/protocol/outer.json pins both, for the Rust and the TypeScript side.

export const RELEASE_HOST = 'com.chakibceran22.vaultkey'
export const DEV_HOST = 'com.chakibceran22.vaultkey.dev'

/** Dev builds reach the dev app only; release builds the real one. */
export function hostName(mode: string): string {
  return mode === 'development' ? DEV_HOST : RELEASE_HOST
}
