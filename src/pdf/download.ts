/** Trigger a browser download of raw bytes. */
export function downloadBytes(bytes: Uint8Array, filename: string, mime = 'application/pdf'): void {
  const copy = bytes.slice();
  const blob = new Blob([copy.buffer as ArrayBuffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFilename(title: string, extension: string): string {
  const base = title.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').slice(0, 80) || 'document';
  return `${base}.${extension}`;
}
