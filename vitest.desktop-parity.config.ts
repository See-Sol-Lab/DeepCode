import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

// Stage-five parity suite for the packaged desktop client: drives the built
// dist/desktop/win-unpacked/DeepCode.exe through playwright-core's Electron
// driver (no separate browser). Self-skips when the packaged exe is absent.
// Serial: every test shares the single fixed port 3080. The tsconfigPaths
// plugin resolves bare workspace imports (e.g. @deepseek-ai/dsh-llm-mock-server
// used by the permission-execution suite) — without it those files fail to
// collect under this config.
export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
  test: {
    include: ['apps/desktop/tests-e2e/**/*.e2e.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    maxWorkers: 1,
  },
})
