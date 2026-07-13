import { defineConfig, mergeConfig } from 'vitest/config'

import baseConfig from './vitest.config.base'

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      setupFiles: ['./setup-tests.ts'],
      testTimeout: 10_000,
      // Disable parallel file execution to prevent anvil port conflicts
      // Each fork test file spawns its own anvil instance.
      fileParallelism: false,
      // Process the SDK through vitest's transform pipeline so vi.spyOn can
      // redefine its exports. Workspace-linked installs get this implicitly;
      // the standalone mirror installs the SDK from npm, which would otherwise
      // be externalized (frozen ESM namespace -> "Cannot redefine property").
      server: {
        deps: {
          inline: [/@panoptic-eng\/sdk/],
        },
      },
    },
  }),
)
