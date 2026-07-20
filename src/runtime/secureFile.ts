import type { Stats } from 'node:fs'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import type { z } from 'zod'

function code(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const value = Reflect.get(error, 'code')
  return typeof value === 'string' ? value : undefined
}

function assertOwnedParent(target: string): void {
  const parent = lstatSync(path.dirname(target))
  const uid = process.getuid?.()
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (uid !== undefined && parent.uid !== uid)
  ) {
    throw new Error('secure file parent is not an owned regular directory')
  }
}

function assertReplaceableTarget(target: string): void {
  try {
    const existing = lstatSync(target)
    const uid = process.getuid?.()
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      (uid !== undefined && existing.uid !== uid)
    ) {
      throw new Error('secure file target is not an owned regular file')
    }
  } catch (error) {
    if (code(error) !== 'ENOENT') throw error
  }
}

function assertSecureFile(stat: Stats, kind: string): void {
  const uid = process.getuid?.()
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid)) {
    throw new Error(`secure ${kind} file is not owner-only`)
  }
}

export function readSecureJson<T>(
  target: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  options: { maxBytes: number; invalid: 'null' | 'throw' },
): T | null {
  let fd: number | undefined
  try {
    assertOwnedParent(target)
    const stat = lstatSync(target)
    if (stat.isSymbolicLink()) throw new Error('secure JSON file is not owner-only')
    assertSecureFile(stat, 'JSON')
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = fstatSync(fd)
    assertSecureFile(opened, 'JSON')
    if (opened.size <= 0 || opened.size > options.maxBytes) {
      throw new Error('secure JSON file size is invalid')
    }
    return schema.parse(JSON.parse(readFileSync(fd, 'utf8')) as unknown)
  } catch (error) {
    if (code(error) === 'ENOENT' || options.invalid === 'null') return null
    throw error
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function readSecureText(target: string, maxBytes: number): string {
  assertOwnedParent(target)
  const stat = lstatSync(target)
  if (stat.isSymbolicLink()) throw new Error('secure text file is not owner-only')
  assertSecureFile(stat, 'text')
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd)
    assertSecureFile(opened, 'text')
    if (opened.size <= 0 || opened.size > maxBytes) {
      throw new Error('secure text file size is invalid')
    }
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

export function writeSecureJson<T>(
  target: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: T,
): void {
  const validated = schema.parse(value)
  writeSecureText(target, `${JSON.stringify(validated, null, 2)}\n`)
}

export function writeSecureText(target: string, value: string): void {
  assertOwnedParent(target)
  assertReplaceableTarget(target)
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`
  let fd: number | undefined
  try {
    fd = openSync(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    )
    writeFileSync(fd, value)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, target)
    chmodSync(target, 0o600)
    const directoryFd = openSync(path.dirname(target), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      fsyncSync(directoryFd)
    } finally {
      closeSync(directoryFd)
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    try {
      unlinkSync(temp)
    } catch {
      // No temporary file was created or it was already renamed.
    }
    throw error
  }
}

export function removeSecureFile(target: string): void {
  try {
    assertOwnedParent(target)
    const stat = lstatSync(target)
    const uid = process.getuid?.()
    if (!stat.isFile() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) {
      throw new Error('secure file target is not an owned regular file')
    }
    unlinkSync(target)
  } catch (error) {
    if (code(error) !== 'ENOENT') throw error
  }
}
