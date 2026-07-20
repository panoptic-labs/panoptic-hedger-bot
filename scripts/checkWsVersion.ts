import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { z } from 'zod'

const require = createRequire(import.meta.url)
export function assertSupportedWsVersion(candidate: string): void {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(candidate)
  if (!match) throw new Error(`hedger runtime resolved malformed or prerelease ws ${candidate}`)
  const [, majorText, minorText, patchText] = match
  const version = [majorText, minorText, patchText].map(Number)
  if (version.some((component) => !Number.isSafeInteger(component))) {
    throw new Error(`hedger runtime resolved malformed ws ${candidate}`)
  }
  const [major = 0, minor = 0] = version

  if (major < 8 || (major === 8 && minor < 21)) {
    throw new Error('hedger runtime requires ws 8.21.0 or later')
  }
}

function main(): void {
  const packageMetadata = z.object({ version: z.string() }).parse(require('ws/package.json'))
  assertSupportedWsVersion(packageMetadata.version)
  console.log(`OK: hedger runtime resolves ws ${packageMetadata.version}`)
}

const entrypoint = process.argv[1]
if (entrypoint && fileURLToPath(import.meta.url) === entrypoint) main()
