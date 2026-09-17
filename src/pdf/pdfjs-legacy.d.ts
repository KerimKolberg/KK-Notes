/**
 * The legacy PDF.js build ships the same API with polyfills for engines that
 * lack the newest built-ins (e.g. `Map.prototype.getOrInsertComputed`). It
 * has no bundled type declarations at its deep import path, so reuse the
 * package's root types.
 */
declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export * from 'pdfjs-dist';
}
