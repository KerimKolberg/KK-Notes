import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Stage PDF.js runtime assets (standard fonts, CMaps, wasm codecs, ICC
 * profiles) into `public/pdfjs` so the viewer can fetch them at runtime
 * without bundling several megabytes into the app chunk.
 */
function pdfjsAssets(): Plugin {
  return {
    name: 'pdfjs-assets',
    configResolved(config) {
      const source = join(config.root, 'node_modules', 'pdfjs-dist');
      const destination = join(config.publicDir, 'pdfjs');
      for (const dir of ['standard_fonts', 'cmaps', 'wasm', 'iccs']) {
        const from = join(source, dir);
        if (existsSync(from)) cpSync(from, join(destination, dir), { recursive: true });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), pdfjsAssets()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
