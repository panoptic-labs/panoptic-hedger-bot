import { defineConfig, mergeConfig } from 'vitest/config'

import baseConfig from './vitest.config.base'

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: [
        'scripts/setup.fork.test.ts',
        'scripts/deleverage.fork.test.ts',
        'scripts/hedgeLp.fork.test.ts',
      ],
      exclude: [],
      testTimeout: 120_000,
      hookTimeout: 30_000,
      fileParallelism: false,
      // NOTE: intentionally no setupFiles. The unit-test setup (setup-tests.ts)
      // scrubs any *_RPC_URL env var and installs an MSW server that throws on
      // unmocked outbound requests — both of which break this fork suite, which
      // needs HEDGER_FORK_RPC_URL and makes real calls to the local anvil fork.
      server: {
        deps: {
          inline: [/@panoptic-eng\/sdk/],
        },
      },
    },
  }),
)
