import { defineConfig } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [
    // The React and Tailwind plugins are both required for Make, even if
    // Tailwind is not being actively used – do not remove them
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      // Alias @ to the src directory
      '@': path.resolve(__dirname, './src'),
    },
  },

  // File types to support raw imports. Never add .css, .tsx, or .ts files to this.
  assetsInclude: ['**/*.svg', '**/*.csv'],

  // Tauri: prevent Vite from obscuring Rust errors
  clearScreen: false,

  server: {
    // Tauri expects a fixed port, fail if that port is not available
    // The Suite uses 5173, so Analytics has its own HMR server in development.
    port: 5174,
    strictPort: true,
    // Allow Tauri's IPC to work with the dev server
    host: '127.0.0.1',
    watch: {
      // Cargo continuously replaces and locks binaries in this directory on
      // Windows. They are not frontend inputs, so Vite must not watch them.
      ignored: ['**/src-tauri/target*/**'],
    },
  },

  // Tauri: use relative paths for assets in production
  base: './',

  build: {
    // Tauri uses Chromium on Windows so we can use the latest JS features
    target: ['es2021', 'chrome105'],
    // Don't minify for debug builds
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    // Produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_DEBUG,
  },
}))
