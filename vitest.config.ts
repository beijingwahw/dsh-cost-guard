import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      thresholds: {
        statements: 90,
        branches: 85,
        lines: 90,
        'src/core/store.ts': { statements: 90, lines: 90, functions: 90 },
      },
    },
  },
})