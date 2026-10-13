import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_PORT = process.env.PORT || 3939;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // ws: true so /api/realtime (WebSocket relay) works in dev too.
    proxy: { '/api': { target: `http://127.0.0.1:${API_PORT}`, ws: true } },
  },
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 3000 },
});
