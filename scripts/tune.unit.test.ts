import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import { Prompter } from './lib/prompts'
import { runTune } from './tune'

// Same pacing trick as prompts.unit.test.ts: readline drops lines buffered
// before a question registers, so feed one answer per macrotask.
function prompter(lines: string[]): Prompter {
  const input = new PassThrough()
  const output = new PassThrough()
  output.resume()
  const p = new Prompter({ input, output })
  let i = 0
  const feed = (): void => {
    if (i < lines.length) {
      input.write(`${lines[i++]}\n`)
      setImmediate(feed)
    }
  }
  setImmediate(feed)
  return p
}

const BASE_ENV_BODY = [
  'CHAIN_ID=1',
  'RPC_URL=https://example.invalid/rpc',
  `POOL_ADDRESS=0x${'11'.repeat(20)}`,
  `SAFE_ADDRESS=0x${'22'.repeat(20)}`,
  `ROLES_MODIFIER_ADDRESS=0x${'33'.repeat(20)}`,
  `ROLE_KEY=0x${'44'.repeat(32)}`,
  `BOT_PRIVATE_KEY=0x${'55'.repeat(32)}`,
  'ASSET_INDEX=0',
  'DELTA_THRESHOLD_BPS=250',
  '',
].join('\n')

// 14 knobs apply with this env (no SFPM, no deleverager).
const KNOB_COUNT = 14

let dir: string
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function makeEnv(): string {
  dir = mkdtempSync(path.join(tmpdir(), 'hedger-tune-'))
  const envPath = path.join(dir, '.env')
  writeFileSync(envPath, BASE_ENV_BODY, { mode: 0o600 })
  return envPath
}

describe('runTune', () => {
  it('accepting every default writes nothing', async () => {
    const envPath = makeEnv()
    const p = prompter(Array(KNOB_COUNT).fill(''))
    await runTune(envPath, p, () => {})
    p.close()
    expect(readFileSync(envPath, 'utf8')).toBe(BASE_ENV_BODY)
  })

  it('patches only the changed knob and preserves the rest of the file', async () => {
    const envPath = makeEnv()
    const answers = Array(KNOB_COUNT).fill('')
    answers[0] = '300' // DELTA_THRESHOLD_BPS is the first knob
    const p = prompter(answers)
    await runTune(envPath, p, () => {})
    p.close()
    const body = readFileSync(envPath, 'utf8')
    expect(body).toContain('DELTA_THRESHOLD_BPS=300')
    expect(body).toContain(`BOT_PRIVATE_KEY=0x${'55'.repeat(32)}`)
    expect(body).not.toContain('DELTA_THRESHOLD_BPS=250')
    // Untouched knobs must not be pinned into the file.
    expect(body).not.toContain('SLIPPAGE_BPS=')
  })

  it('rejects a cross-field violation without writing, then accepts the corrected round', async () => {
    const envPath = makeEnv()
    const badRound = Array(KNOB_COUNT).fill('')
    badRound[9] = '400' // HEDGE_MAX_BASE_FEE_GWEI > URGENT_MAX_BASE_FEE_GWEI (300)
    const goodRound = Array(KNOB_COUNT).fill('')
    goodRound[9] = '40'
    const p = prompter([...badRound, ...goodRound])
    await runTune(envPath, p, () => {})
    p.close()
    const body = readFileSync(envPath, 'utf8')
    expect(body).toContain('HEDGE_MAX_BASE_FEE_GWEI=40')
    expect(body).not.toContain('HEDGE_MAX_BASE_FEE_GWEI=400')
  })

  it('writes conflicting timed bands atomically only after a corrected retry', async () => {
    const envPath = makeEnv()
    const badRound = Array(KNOB_COUNT).fill('')
    badRound[0] = '100'
    badRound[1] = '300000'
    badRound[2] = '100'
    const goodRound = [...badRound]
    goodRound[2] = '50'
    const messages: string[] = []
    const p = prompter([...badRound, ...goodRound])
    await runTune(envPath, p, (message) => messages.push(message))
    p.close()
    const body = readFileSync(envPath, 'utf8')
    expect(messages.join('\n')).toMatch(/inner band; hard threshold is the outer band/)
    expect(body).toContain('DELTA_THRESHOLD_BPS=100')
    expect(body).toContain('TIMED_HEDGE_INTERVAL_MS=300000')
    expect(body).toContain('TIMED_HEDGE_MIN_DRIFT_BPS=50')
    expect(body).not.toContain('TIMED_HEDGE_MIN_DRIFT_BPS=100')
  })

  it('throws a pnpm-onboard pointer when no .env exists', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'hedger-tune-'))
    const p = prompter([])
    await expect(runTune(path.join(dir, '.env'), p, () => {})).rejects.toThrow(/pnpm onboard/)
    p.close()
  })
})
