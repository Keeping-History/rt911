import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'playwright-report/results.json' }],
    ['github'],
    ['list'],
  ],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      // Anchored to the final path segment (a leading "/" or start-of-string,
      // then no further "/" before ".spec.ts"): an unanchored /mobile-.*\.spec\.ts/
      // matches Playwright's *absolute* test path, so it false-positives on
      // every spec whenever a parent directory name contains "mobile-" (e.g.
      // a git worktree checked out as .../mobile-ipod-shell/...) — that
      // collapsed this project's test count to zero in exactly that setup.
      testIgnore: /(^|\/)mobile-[^/]+\.spec\.ts$/,
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'] }, // touch + coarse pointer emulation
      testMatch: /(^|\/)mobile-[^/]+\.spec\.ts$/,
    },
  ],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
  },
});
