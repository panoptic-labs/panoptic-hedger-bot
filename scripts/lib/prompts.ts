import { type Interface, createInterface } from 'node:readline/promises'
import type { Readable } from 'node:stream'
import { Writable } from 'node:stream'

/**
 * Tiny interactive-prompt helpers over node:readline/promises — zero deps.
 * Not for concurrent use; create one Prompter, run the wizard, close it.
 *
 * Streams default to the process stdio; they can be injected for tests.
 */
export class Prompter {
  private rl: Interface
  private muted = false

  constructor(io: { input?: Readable; output?: NodeJS.WritableStream } = {}) {
    const sink = io.output ?? process.stdout
    // A pass-through output that we can mute (for secret entry).
    const output = new Writable({
      write: (chunk, _enc, cb) => {
        if (!this.muted) sink.write(chunk)
        cb()
      },
    })
    // terminal mode drives line-editing on a real TTY; injected test streams
    // are plain pipes, so disable it there (else readline never yields a line).
    this.rl = createInterface({
      input: io.input ?? process.stdin,
      output,
      terminal: io.input ? false : true,
    })
  }

  close(): void {
    this.rl.close()
  }

  /** Free-text prompt with an optional default and validator. */
  async text(
    question: string,
    opts: { default?: string; validate?: (v: string) => string | undefined } = {},
  ): Promise<string> {
    const suffix = opts.default !== undefined ? ` [${opts.default}]` : ''
    for (;;) {
      const answer = (await this.rl.question(`${question}${suffix}: `)).trim()
      const value = answer === '' && opts.default !== undefined ? opts.default : answer
      const err = opts.validate?.(value)
      if (err) {
        process.stdout.write(`  ✗ ${err}\n`)
        continue
      }
      return value
    }
  }

  /** Secret prompt — input is masked. */
  async secret(question: string, validate?: (v: string) => string | undefined): Promise<string> {
    for (;;) {
      process.stdout.write(`${question}: `)
      this.muted = true
      const answer = (await this.rl.question('')).trim()
      this.muted = false
      // Never retain the plaintext secret in readline's in-memory history.
      // `history` isn't in the public readline typings, so reach it via a cast.
      ;(this.rl as unknown as { history?: string[] }).history?.shift()
      process.stdout.write('\n')
      const err = validate?.(answer)
      if (err) {
        process.stdout.write(`  ✗ ${err}\n`)
        continue
      }
      return answer
    }
  }

  /**
   * Single-choice pick-list; returns the chosen value. Options are labelled with
   * 0-based indices (`[0] [1] …`) and the input is parsed strictly as that index,
   * never as the option's value — so a numeric-valued choice like ASSET_INDEX
   * (`[0] 0 — token0`, `[1] 1 — token1`) is unambiguous (index and value coincide).
   * This avoids the old 1-based off-by-one where typing a value selected the
   * wrong row.
   */
  async choice<T extends string>(
    question: string,
    options: { label: string; value: T }[],
    defaultValue?: T,
  ): Promise<T> {
    process.stdout.write(`${question}\n`)
    options.forEach((o, i) => process.stdout.write(`  [${i}] ${o.label}\n`))
    const defaultIdx = defaultValue ? options.findIndex((o) => o.value === defaultValue) : -1
    for (;;) {
      const raw = await this.text('  choose', {
        default: defaultIdx >= 0 ? String(defaultIdx) : undefined,
      })
      const idx = Number(raw.trim())
      if (Number.isInteger(idx) && idx >= 0 && idx < options.length) {
        return options[idx].value
      }
      process.stdout.write(`  ✗ enter a number 0-${options.length - 1}\n`)
    }
  }

  /** Yes/no confirmation. */
  async confirm(question: string, defaultYes = false): Promise<boolean> {
    const answer = await this.text(`${question} (y/n)`, { default: defaultYes ? 'y' : 'n' })
    return /^y(es)?$/i.test(answer)
  }
}

/** Validator: 20-byte hex address. */
export function validateAddress(v: string): string | undefined {
  return /^0x[a-fA-F0-9]{40}$/.test(v) ? undefined : 'must be a 20-byte hex address (0x…)'
}

/** Validator: 32-byte hex private key. */
export function validatePrivateKey(v: string): string | undefined {
  return /^0x[a-fA-F0-9]{64}$/.test(v) ? undefined : 'must be a 32-byte hex private key (0x…)'
}

/** Validator: http(s) URL. */
export function validateUrl(v: string): string | undefined {
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:' ? undefined : 'must be http(s)'
  } catch {
    return 'must be a valid URL'
  }
}
