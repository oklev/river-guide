import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    VitePWA({
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
});
