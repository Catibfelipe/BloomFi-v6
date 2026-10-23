import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import legalPages from './scripts/legal-pages.js';

// Only the public details the legal pages show are read here (never the server keys).
const LEGAL_KEYS = ['LEGAL_NAME', 'LEGAL_ID', 'LEGAL_ADDRESS', 'SUPPORT_EMAIL', 'DPO_NAME', 'DPO_EMAIL'];
const legalEnv = (mode) => {
  const file = loadEnv(mode, process.cwd(), '');
  return Object.fromEntries(LEGAL_KEYS.map((k) => [k, process.env[k] || file[k] || '']));
};

export default defineConfig(({ mode }) => ({
  base: '/',
  build: { rollupOptions: { input: { main: 'index.html', app: 'app/index.html' } } },
  // Wally's local AI runs in its own thread (src/lib/localAi.worker.js), which loads WebLLM as a module.
  worker: { format: 'es' },
  plugins: [
    react(),
    // Terms, Privacy and the site footer with the owner's details (LEGAL_NAME, LEGAL_ID, LEGAL_ADDRESS, SUPPORT_EMAIL).
    legalPages(legalEnv(mode)),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'favicon-64.png', 'apple-touch-icon.png'],
      manifest: {
        id: './',
        name: 'BloomFi — sua coruja do dinheiro',
        short_name: 'BloomFi',
        description: 'Controle financeiro com o Wally: gastos do celular (Apple Pay e Google Pay), Open Finance, orçamentos, metas e investimentos. Conta protegida com criptografia de ponta a ponta.',
        lang: 'pt-BR',
        start_url: '/app/',
        scope: '/',
        display: 'standalone',
        display_override: ['window-controls-overlay', 'standalone'],
        orientation: 'any',
        background_color: '#0b0e13',
        theme_color: '#1f2026',
        categories: ['finance', 'productivity'],
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: 'Novo gasto', short_name: 'Novo gasto', url: '/app/#new', icons: [{ src: 'pwa-192.png', sizes: '192x192' }] },
          { name: 'Contas a pagar', short_name: 'Agenda', url: '/app/#agenda', icons: [{ src: 'pwa-192.png', sizes: '192x192' }] },
          { name: 'Gastos do celular', short_name: 'Celular', url: '/app/#capture', icons: [{ src: 'pwa-192.png', sizes: '192x192' }] },
          { name: 'Falar com o Wally', short_name: 'Wally', url: '/app/#ai', icons: [{ src: 'pwa-192.png', sizes: '192x192' }] },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,woff2}'],
        // The local AI's code (about 6 MB) is not installed with the app: it's fetched the first time someone turns
        // the AI on, and kept from then on (the model itself is kept by WebLLM in the browser's cache).
        globIgnores: ['landing/**', 'assets/localAi.worker-*.js'],
        runtimeCaching: [{
          urlPattern: ({ url }) => url.origin === self.location.origin && /^\/assets\/localAi\.worker-[\w-]+\.js$/.test(url.pathname),
          handler: 'CacheFirst',
          options: { cacheName: 'bloomfi-ai-code', expiration: { maxEntries: 2 } },
        }],
        // Only the app is a single-page app; the site pages (/, /termos.html…) are served as they are.
        navigateFallback: '/app/index.html',
        navigateFallbackAllowlist: [/^\/app(\/|$)/],
        navigateFallbackDenylist: [/^\/api\//, /^\/\.netlify\//],
        cleanupOutdatedCaches: true,
        importScripts: ['/push-sw.js'], // bill reminders (push + notification click)
      },
    }),
  ],
}));
