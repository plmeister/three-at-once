import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const API_PORT = process.env.API_PORT || '4848'

// Base path, e.g. set VITE_BASE=/whichbus/ when deployed behind a path prefix.
const base = process.env.VITE_BASE || '/'

export default defineConfig({
  base,
  server: {
    port: 5173,
    proxy: {
      '/api': `http://localhost:${API_PORT}`,
    },
  },
  build: {
    target: 'es2020',
    sourcemap: true,
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon-180x180.png'],
      manifest: {
        name: 'Which Bus?',
        short_name: 'WhichBus',
        description: 'Next departures from your stop — scheduled and live',
        theme_color: '#0b1f3a',
        background_color: '#0b1f3a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: base,
        scope: base,
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('/api/departures'),
            handler: 'NetworkFirst',
            options: {
              networkTimeoutSeconds: 10,
              cacheName: 'wb-departures',
              expiration: { maxEntries: 40, maxAgeSeconds: 300 },
            },
          },
          {
            urlPattern: ({ url }) => url.pathname.includes('/api/'),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'wb-api',
              expiration: { maxEntries: 80, maxAgeSeconds: 86400 },
            },
          },
        ],
      },
    }),
  ],
})