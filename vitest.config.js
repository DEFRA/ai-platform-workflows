import { defineConfig } from 'vitest/config'

const NEW_AND_CHANGED = 95
const floor = {
  lines: NEW_AND_CHANGED,
  functions: NEW_AND_CHANGED,
  branches: NEW_AND_CHANGED,
  statements: NEW_AND_CHANGED
}

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
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
        // The modules the B28 v2 work added or changed (plan section 8).
        'src/admin.js': floor,
        'src/apply.js': floor,
        'src/events.js': floor,
        'src/github.js': floor,
        'src/main.js': floor,
        'src/pause.js': floor,
        'src/release.js': floor,
        'src/rulesets.js': floor,
        'src/submit.js': floor,
        'src/validate.js': floor
      }
    }
  }
})
