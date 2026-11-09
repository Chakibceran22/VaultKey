import type { IpcResult } from '@renderer/shared/contracts'

export function unwrap<T>(response: IpcResult<T>): T {
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.data
}
