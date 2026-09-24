// ES3 (Easy Save 3) container decoder for SaveFile_Live.es3 — READ-ONLY.
//
// Established format (Phase A research, five independent implementations agree):
//   file      := IV[16] || AES-128-CBC-PKCS7(ciphertext)
//   key       := PBKDF2-HMAC-SHA1(password, salt = IV, iterations = 100, dkLen = 16)
//   plaintext := JSON, optionally gzip-compressed (magic 1F 8B)
//   outer     := { ..., PlayerSaveData: { __type, value: "<inner JSON string>" } }
//   inner     := the actual save JSON (parsed from the nested string)
//
// Uses only node:crypto / node:zlib. Failures are typed SaveSourceErrors; on failure we
// NEVER return an empty/zero-filled checkpoint.

import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { SaveSourceError } from './errors'
import { bigIntSafeJsonParse } from './json-safe'

export const ES3_IV_LENGTH = 16
export const ES3_KEY_ITERATIONS = 100
export const ES3_KEY_LENGTH = 16
const GZIP_MAGIC = 0x1f

/** Derive the AES key exactly as Easy Save 3 does (salt = IV). */
export function deriveEs3Key(password: string, iv: Buffer): Buffer {
  return pbkdf2Sync(password, iv, ES3_KEY_ITERATIONS, ES3_KEY_LENGTH, 'sha1')
}

/**
 * Decrypt the ES3 payload. Typed failures:
 *  - MID_WRITE: payload length after the IV is not AES-block compatible (game caught
 *    mid-write / atomic replace in flight) — transient.
 *  - PASSWORD_INVALID: wrong password or corrupted payload (bad decrypt / bad PKCS7 padding —
 *    the overwhelmingly common cause of this OpenSSL error is a wrong key).
 */
export function decryptEs3(file: Buffer, password: string): Buffer {
  if (file.length < ES3_IV_LENGTH + 16) {
    // too short to hold IV + one block; treat the same as a mid-write catch
    throw new SaveSourceError('MID_WRITE', `file too short (${file.length} bytes)`)
  }
  const iv = file.subarray(0, ES3_IV_LENGTH)
  const ciphertext = file.subarray(ES3_IV_LENGTH)
  if (ciphertext.length % 16 !== 0) {
    throw new SaveSourceError('MID_WRITE', `ciphertext ${ciphertext.length} bytes not block-aligned`)
  }
  const key = deriveEs3Key(password, iv)
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, iv)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    throw new SaveSourceError('PASSWORD_INVALID', 'AES decrypt/padding failed (wrong password or corrupt payload)')
  }
}

/** Gunzip when the plaintext starts with the gzip magic; otherwise return as-is. */
export function maybeGunzip(plaintext: Buffer): Buffer {
  if (plaintext.length >= 2 && plaintext[0] === GZIP_MAGIC && plaintext[1] === 0x8b) {
    try {
      return gunzipSync(plaintext)
    } catch {
      throw new SaveSourceError('PARSE_FAILED', 'gzip magic present but gunzip failed')
    }
  }
  return plaintext
}

export interface Es3Decoded {
  /** Parsed outer JSON object (big ints preserved as strings). */
  outer: Record<string, unknown>
  /** Parsed inner save JSON (PlayerSaveData.value). */
  inner: Record<string, unknown>
}

function parseJsonText(text: string, what: string): unknown {
  let parsed: unknown
  try {
    parsed = bigIntSafeJsonParse(text)
  } catch (error) {
    throw new SaveSourceError('PARSE_FAILED', `${what} JSON parse failed: ${(error as Error).message}`)
  }
  return parsed
}

/**
 * Full decode: decrypt -> (gunzip) -> parse outer JSON -> unwrap PlayerSaveData.value ->
 * parse nested inner JSON. Wrong password, truncation and malformed JSON all produce typed
 * errors; never an empty state.
 */
export function decodeEs3File(file: Buffer, password: string): Es3Decoded {
  const plaintext = maybeGunzip(decryptEs3(file, password))
  const text = plaintext.toString('utf8')

  const outer = parseJsonText(text, 'outer')
  if (typeof outer !== 'object' || outer === null || Array.isArray(outer)) {
    throw new SaveSourceError('PARSE_FAILED', 'outer container is not a JSON object')
  }
  const playerSaveData = (outer as Record<string, unknown>)['PlayerSaveData']
  if (typeof playerSaveData !== 'object' || playerSaveData === null) {
    throw new SaveSourceError('PARSE_FAILED', 'outer container has no PlayerSaveData object')
  }
  const value = (playerSaveData as Record<string, unknown>)['value']
  if (typeof value !== 'string' || value.length === 0) {
    throw new SaveSourceError('PARSE_FAILED', 'PlayerSaveData.value is not a non-empty string')
  }
  const inner = parseJsonText(value, 'nested PlayerSaveData')
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) {
    throw new SaveSourceError('PARSE_FAILED', 'nested PlayerSaveData is not a JSON object')
  }
  return { outer: outer as Record<string, unknown>, inner: inner as Record<string, unknown> }
}
