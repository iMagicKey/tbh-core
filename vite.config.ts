import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'vite-plugin-electron/simple'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    electron({
      main: {
        entry: 'src/main/index.ts',
      },
      preload: {
        input: 'src/preload/index.ts',
        // Emit a deterministic CJS `preload.js` matching the path the main window loads
        // (the plugin's default names it `<entry-basename>.mjs` under "type": "module",
        // which is also dubious for sandboxed preloads).
        vite: {
          build: {
            rolldownOptions: {
              output: {
                entryFileNames: 'preload.js',
              },
            },
          },
        },
      },
      renderer: {},
    }),
  ],
})
