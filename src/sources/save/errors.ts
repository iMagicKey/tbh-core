import type { SaveReasonCode } from '../../shared/save-source'

/**
 * Typed save-source error. `code` is the machine-readable reason; `detail` is sanitized
 * technical context (never contains the ES3 password or raw save contents).
 */
export class SaveSourceError extends Error {
  readonly code: SaveReasonCode
  readonly detail: string | null

  constructor(code: SaveReasonCode, detail?: string) {
    super(`${code}${detail ? `: ${detail}` : ''}`)
    this.name = 'SaveSourceError'
    this.code = code
    this.detail = detail ?? null
  }
}
