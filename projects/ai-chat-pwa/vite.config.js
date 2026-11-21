import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

function collectPublicFiles(relativeDir = '') {
  const absoluteDir = `${projectRoot}public${relativeDir ? `/${relativeDir}` : ''}`;
  const entries = [];
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) entries.push(...collectPublicFiles(relative));
    else entries.push(`./${relative}`);
  }
  return entries;
}

function serviceWorkerPlugin() {
  return {
    name: 'build-service-worker',
    generateBundle(_options, bundle) {
      const bundled = Object.keys(bundle)
        .filter(name => !name.endsWith('.map'))
        .map(name => `./${name}`);
      let publicFiles = [];
      try {
        publicFiles = collectPublicFiles()
          .filter(name => !name.startsWith('./screenshots/'));
      } catch {
        publicFiles = [];
      }
      const assets = [...new Set(['./', ...bundled, ...publicFiles])].sort();
      // Versi cache sensitif terhadap isi file tanpa hash (icon.svg, manifest,
      // PNG publik) karena nama file-nya tidak berubah saat isinya berubah.
      // File bundle ber-hash sudah berubah nama bila isinya berubah.
      const hash = createHash('sha256');
      hash.update(assets.join('\n'));
      for (const name of ['icon.svg', 'manifest.webmanifest']) {
        try { hash.update(readFileSync(`${projectRoot}${name}`)); } catch { /* abaikan */ }
      }
      for (const file of publicFiles) {
        try { hash.update(readFileSync(`${projectRoot}public/${file.slice(2)}`)); } catch { /* abaikan */ }
      }
      const version = hash.digest('hex').slice(0, 10);
      const template = readFileSync(`${projectRoot}sw.js`, 'utf8');
      const output = template
        .replace('// __PRECACHE_INJECT__', `const PRECACHE_ASSETS = ${JSON.stringify(assets)};`)
        .replace('__CACHE_VERSION__', version);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: output });
    }
  };
}

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
  plugins: [serviceWorkerPlugin()]
});
