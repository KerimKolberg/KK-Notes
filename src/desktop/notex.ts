/**
 * `.notex` — the native document format. A small envelope around the
 * document's JSON serialization (metadata, page layouts, stroke arrays,
 * image layers as data URLs, form values, PDF sources as base64).
 */
import { fromSerializable, toSerializable } from '../document/serialization';
import type { Document, SerializedDocument } from '../document/types';

export const NOTEX_FORMAT = 'notex' as const;
export const NOTEX_VERSION = 1 as const;
export const NOTEX_EXTENSION = 'notex';
export const NOTEX_MIME = 'application/x-notex+json';

export const APP_INFO = { name: 'KK-Notes', version: '0.1.0' } as const;

export interface NotexFile {
  readonly format: typeof NOTEX_FORMAT;
  readonly version: typeof NOTEX_VERSION;
  /** ISO-8601 timestamp of the save. */
  readonly savedAt: string;
  readonly app: { readonly name: string; readonly version: string };
  readonly document: SerializedDocument;
}

export interface ParsedNotex {
  readonly document: Document;
  readonly savedAt: string | null;
}

export function buildNotex(doc: Document, savedAt: Date = new Date()): NotexFile {
  return { format: NOTEX_FORMAT, version: NOTEX_VERSION, savedAt: savedAt.toISOString(), app: APP_INFO, document: toSerializable(doc) };
}

export function encodeNotex(doc: Document, savedAt: Date = new Date()): string {
  return JSON.stringify(buildNotex(doc, savedAt));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse a `.notex` envelope, or a bare serialized document (`.json`). */
export function parseNotex(text: string): ParsedNotex {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error('Not a KK-Notes document');
  if (parsed.format === NOTEX_FORMAT) {
    if (parsed.version !== NOTEX_VERSION) throw new Error(`Unsupported .notex version ${String(parsed.version)}`);
    if (!isRecord(parsed.document)) throw new Error('Corrupt .notex file: missing document');
    return {
      document: fromSerializable(parsed.document as unknown as SerializedDocument),
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : null,
    };
  }
  if (Array.isArray(parsed.pages) && 'version' in parsed) {
    return { document: fromSerializable(parsed as unknown as SerializedDocument), savedAt: null };
  }
  throw new Error('Not a KK-Notes document');
}

export function decodeNotex(text: string): Document {
  return parseNotex(text).document;
}

/** Last path segment without directories (Windows or POSIX separators). */
export function fileBaseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/**
 * Document title derived from a file name (`My notes.notex` → `My notes`).
 *
 * Every extension the app can open is stripped, imports included: a notebook
 * imported from GoodNotes should be called `Chemistry`, not
 * `Chemistry.goodnotes`.
 */
export function titleFromFileName(path: string): string {
  return fileBaseName(path).replace(/\.(notex|json|goodnotes|pdf)$/i, '') || 'Untitled note';
}
