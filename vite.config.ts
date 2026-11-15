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

/**
 * Which build this is, for the app to say (`src/lib/buildInfo.ts`). The version number in `package.json` does not
 * move from build to build, so the installer and APK workflows name each build (`KK_BUILD_LABEL`, the release tag it
 * is published under: `windows-42`, `android-50`) and the commit it was built from.
 */
const BUILD_LABEL = process.env.KK_BUILD_LABEL ?? '';
const BUILD_COMMIT = (process.env.GITHUB_SHA ?? '').slice(0, 7);

export default defineConfig({
  define: {
    __KK_BUILD_LABEL__: JSON.stringify(BUILD_LABEL),
    __KK_BUILD_COMMIT__: JSON.stringify(BUILD_COMMIT),
  },
  plugins: [react(), tailwindcss(), pdfjsAssets()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
