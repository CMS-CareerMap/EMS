import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],

  server: {
    proxy: {
      // Everything under /api goes to the Express server, so the browser sees
      // ONE origin in development just as it will in production, where Nginx
      // serves the build and proxies /api on the same domain.
      //
      // Without this the app would be on :5173 and the API on :4000 — two
      // origins, which means CORS and a refresh cookie that behaves subtly
      // differently from the real thing. Debugging cookie problems that exist
      // only on your laptop is a poor use of a day.
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: false,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom') || id.includes('node_modules/react-router-dom')) return 'react'
          if (id.includes('node_modules/lucide-react')) return 'ui'
        },
      },
    },
  },
})
