/** What went wrong, as words to show: an error's message, or whatever was thrown, as text. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
