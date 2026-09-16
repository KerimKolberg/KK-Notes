let fallbackCounter = 0;

/** Collision-resistant stroke id; prefers `crypto.randomUUID` when available. */
export function createStrokeId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  fallbackCounter = (fallbackCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `s_${Date.now().toString(36)}_${fallbackCounter.toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}
