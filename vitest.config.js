import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.js'],
    setupFiles: ['tests/helpers/actions-environment.js'],
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      reporter: ['text', 'lcov'],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 }
    }
  }
})
