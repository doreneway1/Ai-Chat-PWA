import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        assetFileNames: asset => {
          if (['icon.svg', 'manifest.webmanifest'].includes(asset.name)) return '[name][extname]';
          return 'assets/[name]-[hash][extname]';
        }
      }
    }
  },
  plugins: [{
    name: 'copy-service-worker',
    closeBundle() {
      copyFileSync(`${projectRoot}sw.js`, `${projectRoot}dist/sw.js`);
    }
  }]
});
