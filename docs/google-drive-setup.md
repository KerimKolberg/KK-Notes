# Setting up Google Drive sync

Follow this once and sync works on Windows and on Android. It takes about 20
minutes, most of it waiting for an APK build.

Work through it in order. Stage 2 gets Windows syncing and is the quick win;
stages 3–5 are Android, which needs more setup because Google ties an Android
OAuth client to the exact key your APK is signed with.

Nothing here is secret. An installed app is a **public** OAuth client — that is
the entire reason this app uses PKCE instead of a client secret — so the client
id can live in a repository variable and be read out of the binary by anyone,
and it buys them nothing without the verifier that never leaves the process.

## What this build expects

Values baked into the code. If you change one, change it in both places.

| Thing | Value | Where it comes from |
| --- | --- | --- |
| Android package name | `com.notex.app` | `identifier` in `src-tauri/tauri.conf.json` |
| Android redirect | `com.notex.app:/oauth2redirect` | `ANDROID_SCHEME` in `src-tauri/src/drive_commands.rs` |
| Desktop redirect | `http://127.0.0.1:<random port>/oauth2redirect` | `RedirectTarget::Loopback` in `notes-sync/src/oauth.rs` |
| Scopes | `.../auth/drive.file` and `.../auth/userinfo.email` | `AuthSession::new` |
| Client id | `NOTEX_GOOGLE_CLIENT_ID` | env var at build time, or at run time |

The desktop redirect port is different every sign-in, on purpose (RFC 8252 §7.3).
You never register it: Google accepts any loopback port for a Desktop client.

## Stage 1 — the Google Cloud project

1. Go to <https://console.cloud.google.com/> and create a project. Call it
   anything; `KK-Notes` is fine.
2. **Enable the Drive API.** *APIs & Services → Library →* search "Google Drive
   API" *→ Enable*. Sync fails with a `403 accessNotConfigured` without this, and
   that error names the project rather than the missing step, so it is easy to
   miss.
3. Open the consent screen settings. Google is mid-rename here, so you will see
   either *APIs & Services → OAuth consent screen* or *Google Auth Platform* with
   **Branding**, **Audience**, **Data access** and **Clients** pages. Both lead to
   the same settings.
4. User type **External**. (Internal only exists for Workspace organisations and
   would restrict sign-in to your own domain.)
5. Fill in the app name, your support email, and a developer contact email.
   `KK-Notes` is a fine app name.
6. Under **Data access** (or *Scopes*), add exactly these two:

   ```
   https://www.googleapis.com/auth/drive.file
   https://www.googleapis.com/auth/userinfo.email
   ```

   `drive.file` is the narrow one: it grants access **only to files this app
   creates**. KK-Notes cannot see anything else in your Drive, and that is
   deliberate — even if it were compromised, the rest of your Drive is not
   reachable. `userinfo.email` is what lets the panel say which account you are
   signed in as.

7. **Publish the app.** Under **Audience**, click *Publish app* and confirm.

   This step is the difference between sync that works and sync that logs you out
   every week. While the app is in **Testing**, Google issues refresh tokens that
   expire after **7 days**, so you would have to sign in again every Monday. In
   production they do not expire (unless revoked, or unused for about six months).

   Both scopes above are **non-sensitive**, so publishing needs no verification
   review and takes effect immediately. You may be offered a *branding*
   verification if you want your app name and logo shown without an "unverified
   app" notice — that is optional and unrelated to whether sync works.

   If Google does demand verification here, stop and tell me: it would mean the
   scope classification has changed and the guide needs revisiting.

## Stage 2 — Windows (the quick win)

1. *Clients → Create client → Application type: **Desktop app***. Name it
   `KK-Notes desktop`.
2. There is nothing to register: Desktop clients take no redirect URIs. Copy the
   **Client ID** (it ends in `.apps.googleusercontent.com`).
3. Build or run the desktop app with it set:

   ```powershell
   # PowerShell, in the repo
   $env:NOTEX_GOOGLE_CLIENT_ID = "…apps.googleusercontent.com"
   npm run desktop:build      # or: npm run desktop:dev
   ```

   The client id is read at build time **and** at run time, run time first
   (`client_id()` in `drive_commands.rs`), so you can also point an already-built
   `.exe` at a different project by setting the variable before launching it.

4. Open the app → the library's cloud button → **Sign in with Google Drive**. Your
   browser opens, you consent, and the tab says *"You are signed in to Google
   Drive. You can close this tab and go back to KK-Notes."* The panel should then
   read **Connected as you@gmail.com.**

If that worked, Windows sync is done. Everything below is Android.

## Stage 3 — a stable signing key (do this before stage 4)

Google pins an Android OAuth client to the package name **plus the SHA-1
fingerprint of the certificate the APK is signed with**. Debug APKs are signed
with Gradle's debug key, which lives at `~/.android/debug.keystore` — and Gradle
*mints a fresh one when it is missing*, which on a clean CI runner is every single
build. Left alone, Android sign-in would work for exactly one APK and then break
with `invalid_request`.

So give CI a fixed key, once:

1. *Actions → **Android debug keystore** → Run workflow.* It needs nothing
   installed on your machine.
2. Open the finished run's log. The **Print the SHA-1** step shows a line like
   `SHA1: A1:B2:C3:…`. Keep that window open — stage 4 needs it.
3. Download the run's **debug-keystore-base64** artifact and open
   `debug.keystore.b64`. It is one long line of text.
4. *Settings → Secrets and variables → Actions → Secrets → New repository
   secret*, named exactly:

   ```
   ANDROID_DEBUG_KEYSTORE_B64
   ```

   with that line as the value.
5. **Delete the artifact** from the run's page. It holds a private key. It is only
   a debug key for a personal build, not a Play Store upload key, but anyone
   holding it could sign an APK that Android would accept as an *update* to this
   app — which would inherit its stored data.

From now on every APK is signed with that key, and the `Android APK` workflow
prints the same SHA-1 every time. If you ever see a different one in a build log,
something dropped the secret, and Android sign-in will be broken until you update
the fingerprint in stage 4.

## Stage 4 — the Android OAuth client

1. *Clients → Create client → Application type: **Android***. Name it
   `KK-Notes Android`.
2. **Package name:** `com.notex.app` — exactly this. A typo here produces a
   sign-in that fails with no useful message.
3. **SHA-1 certificate fingerprint:** the value from stage 3, colons included.
4. **Enable the custom URI scheme.** On the client's page open **Advanced
   Settings** and turn on the custom URI scheme option.

   Do not skip this. Google disabled custom URI schemes *by default* for new
   Android clients — they are vulnerable to app impersonation — and without the
   toggle the consent screen dies on `invalid_request` with wording about custom
   scheme URIs not being allowed. This is the single most common way this setup
   is got wrong.

   (Google's recommended alternative is their Identity Services SDK, which would
   mean a native Android dependency and a second auth path to maintain. This app
   uses the RFC 8252 custom-scheme flow instead, which is why the toggle is
   needed.)

5. Copy this client's **Client ID**. It is a *different* id from the desktop one.

## Stage 5 — point the APK at it and test

1. *Settings → Secrets and variables → Actions → **Variables** tab → New
   repository variable* (a variable, not a secret — it is not confidential and
   variables are readable in logs, which helps when debugging):

   ```
   Name:  NOTEX_GOOGLE_CLIENT_ID
   Value: <the Android client id from stage 4>
   ```

   CI only ever builds the Android app, so this variable holds the **Android**
   client id. The desktop client id stays on your own machine, from stage 2.

2. *Actions → Android APK → Run workflow.* Wait ~5 minutes.
3. Install the `.apk` from the release the run attaches, then open the library's
   cloud button → **Sign in with Google Drive**. Chrome opens, you consent, and
   Android switches back to KK-Notes with the panel reading **Connected as …**.
4. Make a note, save it, and check Drive: there should be a **KK-Notes Sync**
   folder containing a `.notex` file.

## If something goes wrong

The panel and the notices name the cause. Match the message you actually see:

| What you see | What it means |
| --- | --- |
| "This build has no Google client id, so Drive sync is unavailable." | The build had no `NOTEX_GOOGLE_CLIENT_ID`. On Android, the repository *variable* was unset when the APK was built — setting it now needs a rebuild. On desktop, set the env var. |
| "Cloud sync runs in the desktop and Android apps." | You are in a browser. There is no Rust side, so there is nothing to sync with. Expected. |
| "Connected, but KK-Notes was not given access to Drive. Sign in again to fix it." | You unticked the Drive permission on the consent screen. Sign in again and leave it ticked. |
| Consent screen: `invalid_request`, custom scheme URIs not allowed | Stage 4 step 4 — the custom URI scheme toggle is off. |
| Consent screen: `redirect_uri_mismatch` on Android | The package name or SHA-1 does not match the APK. Compare the SHA-1 in the build log against the one on the client. |
| Sign-in worked once, then stopped after a rebuild | The signing key changed. Stage 3 — check the secret exists, and compare the build log's SHA-1 with the client's. |
| Sign-in worked, then stopped after about a week | The app is still in **Testing**. Stage 1 step 7 — publish it. |
| `403 accessNotConfigured` when syncing | Stage 1 step 2 — the Drive API is not enabled on the project. |
| Desktop: browser says it cannot connect | The loopback listener closed. It waits 5 minutes (`REDIRECT_TIMEOUT`); start the sign-in again. |

## Known limits

- **Not verified on real hardware.** The desktop loopback flow and the Rust side
  are unit-tested, and the Android manifest's intent filters are checked by
  `npm run check:android` — but the end-to-end Android sign-in has never been run
  on a device. Stage 5 step 3 is the first real test.
- **The 5-minute window.** If you leave the consent screen open longer than that,
  the desktop listener gives up and you start again.
- **`drive.file` only.** Sync can see the files it created and nothing else, so it
  cannot adopt notes you upload to Drive by hand.
- **One account.** Signing in as a second Google account replaces the first.
