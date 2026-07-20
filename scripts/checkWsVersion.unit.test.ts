import { describe, expect, it } from 'vitest'

import { assertSupportedWsVersion } from './checkWsVersion'

describe('ws release version gate', () => {
  it.each(['8.21', '8.21.0-rc.1', '8.21.x', '08.21.0', '8.21.0.1'])(
    'rejects malformed or prerelease version %s',
    (version) => expect(() => assertSupportedWsVersion(version)).toThrow(/malformed|prerelease/),
  )

  it('enforces the 8.21.0 minimum', () => {
    expect(() => assertSupportedWsVersion('8.20.99')).toThrow(/8\.21\.0/)
    expect(() => assertSupportedWsVersion('8.21.0')).not.toThrow()
    expect(() => assertSupportedWsVersion('9.0.0')).not.toThrow()
  })
})
