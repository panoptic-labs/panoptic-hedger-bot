import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import { getSafeZodiacAddresses, ROLES_V2_1_MASTERCOPY } from './safeZodiacRegistry'

const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`

describe('getSafeZodiacAddresses', () => {
  it('resolves canonical addresses for a listed chain (mainnet)', () => {
    const addrs = getSafeZodiacAddresses(1, {}, {})
    expect(addrs.rolesMastercopy).toBe(ROLES_V2_1_MASTERCOPY)
    expect(addrs.safeProxyFactory).toMatch(/^0x[a-fA-F0-9]{40}$/)
    expect(addrs.safeSingleton).toMatch(/^0x[a-fA-F0-9]{40}$/)
    expect(addrs.moduleProxyFactory).toMatch(/^0x[a-fA-F0-9]{40}$/)
    expect(addrs.multiSend).toMatch(/^0x[a-fA-F0-9]{40}$/)
  })

  it('lets explicit overrides win over the registry', () => {
    const override = A(0xabc)
    const addrs = getSafeZodiacAddresses(1, { rolesMastercopy: override }, {})
    expect(addrs.rolesMastercopy).toBe(getAddress(override))
  })

  it('reads overrides from env for an unlisted chain', () => {
    const env = {
      SAFE_PROXY_FACTORY: A(1),
      SAFE_SINGLETON: A(2),
      ZODIAC_MODULE_PROXY_FACTORY: A(3),
      ROLES_MASTERCOPY: A(4),
      SAFE_MULTISEND: A(5),
    } as NodeJS.ProcessEnv
    const addrs = getSafeZodiacAddresses(999999, {}, env)
    expect(addrs.safeProxyFactory).toBe(A(1))
    expect(addrs.rolesMastercopy).toBe(A(4))
    expect(addrs.multiSend).toBe(A(5))
  })

  it('throws listing the missing env vars for an unlisted chain', () => {
    expect(() => getSafeZodiacAddresses(999999, {}, {})).toThrow(/SAFE_PROXY_FACTORY/)
  })

  it('throws on a malformed override', () => {
    const env = { SAFE_PROXY_FACTORY: '0xnothex' } as NodeJS.ProcessEnv
    expect(() => getSafeZodiacAddresses(1, {}, env)).toThrow(/Malformed/)
  })

  it('checksums resolved addresses', () => {
    const lower = '0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67'
    const addrs = getSafeZodiacAddresses(1, { safeProxyFactory: lower as `0x${string}` }, {})
    // getAddress returns EIP-55 checksummed form — not all-lowercase.
    expect(addrs.safeProxyFactory).not.toBe(lower)
    expect(addrs.safeProxyFactory.toLowerCase()).toBe(lower)
  })
})
