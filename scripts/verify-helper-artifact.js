// Verifies the memory-reader helper artifact exists before packaging.
// Production Windows packaging MUST fail when the helper is missing (never ship
// TBH Core silently without the MemorySource).
import { existsSync } from 'node:fs'
import path from 'node:path'

const exe = path.join('helper', 'memory-reader', 'dist', 'tbh-core-reader', 'tbh-core-reader.exe')
const profile = path.join('helper', 'memory-reader', 'dist', 'tbh-core-reader', '_internal', 'profiles', 'tbh-1.2.8.json')

if (!existsSync(exe)) {
  console.error(`[helper] MISSING: ${exe} — run "pnpm helper:build" first`)
  process.exit(1)
}
if (!existsSync(profile)) {
  // PyInstaller>=6 layout: data may land in _internal; tolerate both shapes
  const alt = path.join('helper', 'memory-reader', 'dist', 'tbh-core-reader', 'profiles', 'tbh-1.2.8.json')
  if (!existsSync(alt)) {
    console.error(`[helper] MISSING bundled profile (checked ${profile} and ${alt})`)
    process.exit(1)
  }
}
console.log(`[helper] OK: ${exe}`)
