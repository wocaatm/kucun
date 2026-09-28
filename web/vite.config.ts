import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3100',
      '/files': 'http://127.0.0.1:3100',
    },
  },
  build: { chunkSizeWarningLimit: 1500 },
});
