import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  base: '/',
  plugins: [
    react(),
    tailwindcss(),
  ],
  build: {
    /** Evita <link rel="modulepreload"> no usados de inmediato (advertencias en Safari). */
    modulePreload: false,
    sourcemap: false,
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/react') || id.includes('/node_modules/react-dom')) {
            return 'react'
          }
          if (id.includes('/node_modules/@supabase/')) {
            return 'supabase'
          }
        },
      },
    },
  },
})