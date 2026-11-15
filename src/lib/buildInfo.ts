/**
 * Which build of the app this is.
 *
 * The version number stays where it is from build to build, so on its own it cannot answer "is this the build with
 * the fix in it?". Each installer and APK is built with the name of the release it is published under and the commit
 * it came from (`vite.config.ts`); a build made by hand has neither and says so.
 */
import { APP_INFO } from '../desktop/notex';

declare const __KK_BUILD_LABEL__: string | undefined;
declare const __KK_BUILD_COMMIT__: string | undefined;

export interface BuildInfo {
  readonly version: string;
  /** The release this build is published under (`windows-42`), or '' for one built by hand. */
  readonly label: string;
  /** The first seven characters of the commit, or ''. */
  readonly commit: string;
}

export const BUILD_INFO: BuildInfo = {
  version: APP_INFO.version,
  label: typeof __KK_BUILD_LABEL__ === 'string' ? __KK_BUILD_LABEL__ : '',
  commit: typeof __KK_BUILD_COMMIT__ === 'string' ? __KK_BUILD_COMMIT__ : '',
};

/** "KK-Notes 0.1.0 · windows-42 · 78d6f1c", or "KK-Notes 0.1.0 · local build". */
export function describeBuild(info: BuildInfo = BUILD_INFO): string {
  const parts = [info.label, info.commit].filter((part) => part !== '');
  return `${APP_INFO.name} ${info.version} · ${parts.length > 0 ? parts.join(' · ') : 'local build'}`;
}
