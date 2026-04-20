import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Deployed at https://diem.antseed.com as a static bundle.
// Port 5180 keeps dev-servers for the three webapps distinct (website 3000,
// payments portal 5173 default, diem-staking 5180).
export default defineConfig({
  plugins: [react()],
  server: { port: 5180 },
  build: { outDir: 'dist', sourcemap: true },
});
