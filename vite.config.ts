import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => ({
  build: {
    rollupOptions: {
      // view.html opens trip reports shared through Google Drive.
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        view: fileURLToPath(new URL('view.html', import.meta.url)),
      },
    },
  },
  plugins: [
    VitePWA({
      // The Android app ships its files inside the APK; no service worker needed.
      disable: mode === 'android',
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'River Guide',
        short_name: 'River Guide',
        description: 'Editable paddling map: hazards, access points, routes and offline maps.',
        theme_color: '#0f4c5c',
        background_color: '#0f4c5c',
        display: 'standalone',
        start_url: '.',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        // App shell only; map tiles are cached separately by src/tiles.ts.
        globPatterns: ['**/*.{js,css,html,svg,png}'],
      },
    }),
  ],
}));
