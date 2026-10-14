import { configDefaults, defineConfig } from 'vitest/config';

// Real-device acceptance tests drive the installed Mirroir binary and need a
// connected iPhone; they only run when explicitly requested.
const deviceTests = process.env.IPHONE_AI_DEVICE_TESTS === '1';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...(deviceTests ? [] : ['test/device/real-device.test.ts'])],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
  },
});
