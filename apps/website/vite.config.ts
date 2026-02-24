import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// SPA fallback: production hosting must rewrite all routes to index.html (e.g. Netlify _redirects, Vercel rewrites, or nginx try_files).
export default defineConfig({
  plugins: [react()],
  base: '/',
})
