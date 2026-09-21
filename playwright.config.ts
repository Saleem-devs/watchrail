import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node dist/main.js',
      cwd: './apps/api',
      url: 'http://localhost:4000/api/monitors',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'node node_modules/next/dist/bin/next start --port 3000',
      cwd: './apps/web',
      url: 'http://localhost:3000',
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
