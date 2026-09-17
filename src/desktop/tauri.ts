/**
 * Thin, lazily-loaded access to the Tauri APIs. Every `@tauri-apps/*` module
 * is imported on demand so the web build never pays for them, and callers
 * branch on `isTauri()` to pick browser fallbacks.
 */

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export type InvokeArgs = Record<string, unknown> | ArrayBuffer | Uint8Array;

export async function tauriInvoke<T>(command: string, args?: InvokeArgs, options?: { headers?: Record<string, string> }): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args as Parameters<typeof invoke>[1], options as Parameters<typeof invoke>[2]);
}

export async function tauriDialog(): Promise<typeof import('@tauri-apps/plugin-dialog')> {
  return import('@tauri-apps/plugin-dialog');
}

export async function tauriWindow(): Promise<import('@tauri-apps/api/window').Window> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}
