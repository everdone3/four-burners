/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Offline app shell. src/sw.ts precaches the build; the app registers it itself (src/ui/useAppUpdate.ts).
    // The worker ships as /sw.js with scope '/'. Keep both forever: push subscriptions bind to them.
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectRegister: false,
      registerType: 'prompt',
      manifest: false, // public/manifest.webmanifest, linked from index.html
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
  // Short commit hash on Vercel builds, shown in Settings.
  define: { __APP_VERSION__: JSON.stringify(process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || 'dev') },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { port: 5180 },
  // 15 s per test: the full suite runs PGlite (real Postgres) and bundler tests in parallel, and on a busy machine
  // timing-sensitive tests could pass alone yet hit the 5 s default under load.
  test: { environment: 'node', include: ['src/**/*.test.ts'], testTimeout: 15_000 },
});
