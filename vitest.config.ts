import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.json'] })],
  test: {
    globals: true,
    setupFiles: ['./setup-tests.ts'],
    testTimeout: 10_000,
    exclude: ['**/*.fork.test.ts', '**/node_modules/**', '**/dist/**'],
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
})
