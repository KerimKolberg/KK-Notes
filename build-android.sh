#!/usr/bin/env bash
#
# Build the Android APK.
#
#   ./build-android.sh              debug APK    (signed with the debug key, installs directly)
#   ./build-android.sh --release    release APK  (unsigned; sign it before installing)
#   ./build-android.sh --check      prerequisites only
#   ./build-android.sh --abi <name> one ABI only: aarch64 | armv7 | i686 | x86_64
#
# Without --abi the APK carries every ABI, which is right for something you
# hand to unknown devices but means four Rust cross-compiles and a file three
# times the size. Every phone and tablet shipped in years is aarch64, so a
# build meant for a specific device wants --abi aarch64.
#
# The heavy lifting is `tauri android build --apk`; this wrapper checks the
# environment first (the failure messages from a missing NDK are cryptic),
# makes sure the Rust Android targets are installed, and re-applies this
# project's Android customizations in case `tauri android init` regenerated
# them.
set -euo pipefail

cd "$(dirname "$0")"

MODE="debug"
CHECK_ONLY="false"
ABI=""
while [ $# -gt 0 ]; do
  case "$1" in
    --release) MODE="release" ;;
    --debug) MODE="debug" ;;
    --check) CHECK_ONLY="true" ;;
    --abi)
      shift
      ABI="${1:-}"
      case "$ABI" in
        aarch64|armv7|i686|x86_64) ;;
        *) echo "unknown --abi: ${ABI:-(missing)} (expected aarch64, armv7, i686 or x86_64)" >&2; exit 2 ;;
      esac
      ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

# Rust's triple for each of the ABI names the Tauri CLI uses.
rust_target_for() {
  case "$1" in
    aarch64) echo "aarch64-linux-android" ;;
    armv7) echo "armv7-linux-androideabi" ;;
    i686) echo "i686-linux-android" ;;
    x86_64) echo "x86_64-linux-android" ;;
  esac
}

fail() { echo "error: $*" >&2; exit 1; }
note() { echo "  • $*"; }

echo "Checking the Android build environment…"

command -v java >/dev/null 2>&1 || fail "java not found. Install a JDK (17 or newer) or set JAVA_HOME."
note "java $(java -version 2>&1 | grep -m1 'version "' | sed 's/.*version "\([^"]*\)".*/\1/')"

[ -n "${ANDROID_HOME:-}" ] || [ -n "${ANDROID_SDK_ROOT:-}" ] ||
  fail "ANDROID_HOME is not set. Install the Android SDK (Android Studio → SDK Manager) and export ANDROID_HOME."
SDK="${ANDROID_HOME:-$ANDROID_SDK_ROOT}"
[ -d "$SDK" ] || fail "ANDROID_HOME points at $SDK, which does not exist."
note "sdk $SDK"

[ -n "${NDK_HOME:-}" ] || fail "NDK_HOME is not set. Install the NDK (SDK Manager → SDK Tools → NDK (Side by side)) and export NDK_HOME."
[ -d "$NDK_HOME" ] || fail "NDK_HOME points at $NDK_HOME, which does not exist."
note "ndk $NDK_HOME"

[ -d "$SDK/platforms/android-34" ] || echo "  ! android-34 platform not found under $SDK/platforms — the build will try to download it"

command -v rustup >/dev/null 2>&1 || fail "rustup not found. Install Rust from https://rustup.rs."
if [ -n "$ABI" ]; then
  TARGETS="$(rust_target_for "$ABI")"
else
  TARGETS="aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android"
fi
INSTALLED="$(rustup target list --installed)"
for target in $TARGETS; do
  if ! echo "$INSTALLED" | grep -qx "$target"; then
    echo "  + rustup target add $target"
    [ "$CHECK_ONLY" = "true" ] || rustup target add "$target"
  fi
done
note "rust targets ready"

if [ "$CHECK_ONLY" = "true" ]; then
  echo "Environment looks good."
  exit 0
fi

# `tauri android init` writes the machine-specific pieces (tauri.settings.gradle,
# tauri.build.gradle.kts, tauri.properties, the Kotlin bindings for plugins).
# The rest of gen/android is committed, so this only runs when they are absent.
if [ ! -f "src-tauri/gen/android/app/tauri.build.gradle.kts" ]; then
  echo "Generating the machine-specific Gradle files (tauri android init)…"
  npm run tauri -- android init --ci
fi

echo "Applying this project's Android customizations…"
node scripts/android-customize.mjs

echo "Building the $MODE APK${ABI:+ for $ABI}…"
BUILD_ARGS="--apk"
[ "$MODE" = "release" ] || BUILD_ARGS="$BUILD_ARGS --debug"
[ -z "$ABI" ] || BUILD_ARGS="$BUILD_ARGS --target $ABI"
# shellcheck disable=SC2086 # the flags are built above and must word-split
npm run tauri -- android build $BUILD_ARGS

echo
echo "APKs:"
find src-tauri/gen/android/app/build/outputs/apk -name '*.apk' -print 2>/dev/null | sed 's/^/  /' || true
echo
if [ "$MODE" = "release" ]; then
  echo "Release APKs are unsigned. Sign and align before installing:"
  echo "  \$ANDROID_HOME/build-tools/<version>/zipalign -p 4 in.apk aligned.apk"
  echo "  \$ANDROID_HOME/build-tools/<version>/apksigner sign --ks my.keystore aligned.apk"
else
  BUILT="$(find src-tauri/gen/android/app/build/outputs/apk -name '*.apk' 2>/dev/null | head -1)"
  echo "Install on a connected device with:"
  echo "  adb install -r ${BUILT:-src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk}"
fi
