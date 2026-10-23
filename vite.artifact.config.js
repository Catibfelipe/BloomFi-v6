// Build used for the hosted single-page version (no service worker).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  base: './',
  publicDir: false,
  plugins: [react()],
  // No local AI in the link version: its engine file is swapped for a stub, so WebLLM stays out of the page.
  resolve: { alias: [{ find: 'virtual:pwa-register', replacement: '/src/lib/sw-stub.js' }, { find: /^\.\/localAiEngine\.js$/, replacement: '/src/lib/localAiEngine-stub.js' }] },
  define: { 'import.meta.env.VITE_ARTIFACT': JSON.stringify('1') },
  build: { outDir: 'dist-artifact', assetsInlineLimit: 100000000, cssCodeSplit: false, modulePreload: false,
    rolldownOptions: { input: 'app/index.html', output: { codeSplitting: false } } },
});
