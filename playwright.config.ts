// End-to-end tests (Playwright) for the core flows, on an iPhone 17 Pro Max screen in WebKit (Safari's engine).
//   npm run e2e
// The dev server runs on its own port with no Supabase configuration, so tests never touch your account:
// everything stays in the test browser's own storage, which starts empty for every test.
import { defineConfig } from '@playwright/test';

const PORT = 5199;

/** iPhone 17 Pro Max: 440 x 956 points at 3x, Safari on iOS 26. */
export const IPHONE_17_PRO_MAX = {
  viewport: { width: 440, height: 956 },
  screen: { width: 440, height: 956 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
};

export default defineConfig({
  testDir: 'e2e',
  // One at a time: several desktop WebKit instances at once slow each other down enough to expire
  // time-limited UI (the 5-second undo toast) before a test can tap it.
  workers: 1,
  retries: 1,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'iphone-17-pro-max',
      use: { browserName: 'webkit', ...IPHONE_17_PRO_MAX, reducedMotion: 'reduce' },
    },
  ],
  webServer: {
    // Empty Supabase settings: sync is "not set up" in this build, whatever .env.local holds.
    command: `node node_modules/vite/bin/vite.js --port ${PORT} --strictPort`,
    env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_PUBLISHABLE_KEY: '', VITE_VAPID_PUBLIC_KEY: '' },
    port: PORT,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
