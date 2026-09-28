import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs so the same bundle loads from a file:// path inside
  // the Electron shell as well as from the orchestrator's static route.
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/session': {
        target: 'http://127.0.0.1:4711',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 5173,
  },
});
