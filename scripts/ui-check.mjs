/**
 * Browser checks for the things a jsdom-less unit suite cannot see: stacking
 * order, hit-testing and layout at a real viewport size.
 *
 * `vitest` here runs in a `node` environment with no DOM, which is the right
 * trade for the geometry and state-machine code that makes up most of this
 * app — but it means a control can be perfectly wired and still be untappable
 * because something is painted on top of it. That is exactly the class of bug
 * this script covers, driving a real Chromium over the production build.
 *
 *   npm run check:ui                  # builds nothing; expects `dist/`
 *   npm run check:ui -- --url=http://localhost:5173
 *
 * It needs `playwright-core` and a Chromium binary. Neither is a dependency of
 * this project (they are big, and CI installs them separately), so the script
 * reports why it cannot run and exits 0 rather than failing a build that has
 * nothing wrong with it. A check that actually runs and fails exits 1.
 */
import { spawn } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';

const args = process.argv.slice(2);
const urlArg = args.find((a) => a.startsWith('--url='))?.slice('--url='.length);
const BASE = urlArg ?? 'http://localhost:4173';
const PORT = Number(new URL(BASE).port || 80);

/** A phone-sized portrait viewport with a real touchscreen and no mouse. */
const PHONE = { width: 412, height: 915, deviceScaleFactor: 2.625 };
/** A laptop, where the arranger is a side panel rather than a full-screen sheet. */
const DESKTOP = { width: 1280, height: 800, deviceScaleFactor: 1 };

function skip(reason) {
  console.log(`ui-check: skipped — ${reason}`);
  process.exit(0);
}

/** Where the environment keeps its browsers, if it keeps them anywhere. */
function findChromium() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return null;
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith('chromium')) continue;
    for (const rel of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
      const candidate = join(root, entry, rel);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function isListening(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.on('connect', () => (socket.destroy(), resolve(true)));
    socket.on('error', () => resolve(false));
  });
}

async function waitForServer(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isListening(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// ---------------------------------------------------------------- assertions

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/**
 * Tap, reporting a blocked tap as a failed check instead of throwing.
 * Playwright refuses to tap through an overlay and says which element is in the
 * way, which is precisely the failure this file exists to catch — so it has to
 * come out as a FAIL line, not an unhandled timeout that hides the checks after
 * it.
 */
async function tapOrFail(page, selector, name) {
  try {
    await page.tap(selector, { timeout: 4_000 });
    return true;
  } catch (err) {
    // Playwright words it as "<child> from <owner> subtree intercepts pointer
    // events", or just "<owner> intercepts…" when the overlay is hit directly.
    // The owner is the useful half, so prefer it; otherwise take the last tag
    // named before the phrase, since the first one is the target we asked for.
    const message = String(err.message ?? err);
    const at = message.indexOf('intercepts pointer events');
    const before = at < 0 ? '' : message.slice(0, at);
    const owner = /from <([a-z]+)[\s\S]*$/.exec(before);
    const last = [...before.matchAll(/<([a-z]+)[\s>]/g)].pop();
    const blocker = owner?.[1] ?? last?.[1];
    check(name, false, blocker ? `blocked by <${blocker}>` : 'tap timed out');
    return false;
  }
}

/** Centre of an element, in viewport coordinates. */
function centre(box) {
  return [box.x + box.width / 2, box.y + box.height / 2];
}

/**
 * Is the arranger toggle the thing a tap at its own centre would actually
 * reach? `elementFromPoint` answers the question a click handler cannot: it
 * walks the real paint order, so anything covering the button shows up here
 * even though the button is still mounted, enabled and wired.
 */
async function toggleIsReachable(page, box) {
  return page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    return el !== null && el.closest('[data-arranger-toggle]') !== null;
  }, centre(box));
}

/**
 * Wait for the slide to finish. Playwright calls an element "visible" the
 * instant it has a box, which for this drawer is while it is still off-screen
 * at `translate-x-full` — so every geometry assertion has to wait for it to
 * land or it measures the animation instead of the layout.
 *
 * Measured off the rect rather than the computed style on purpose: Tailwind v4
 * animates the standalone `translate` property, so `getComputedStyle().transform`
 * reads `none` throughout and anything keyed off it settles instantly and lies.
 */
async function settle(page) {
  await page.waitForFunction(() => {
    const el = document.querySelector('#page-arranger');
    if (el === null) return false;
    // Right-anchored: it is home when its right edge meets the viewport's.
    return Math.abs(el.getBoundingClientRect().right - window.innerWidth) < 1;
  }, null, { timeout: 3_000 });
}

/** Open a fresh document from the library and wait for the top bar. */
async function openDocument(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-new-document]', { timeout: 20_000 });
  await page.click('[data-new-document]');
  await page.waitForSelector('[data-arranger-toggle]', { timeout: 20_000 });
}

const OPEN = '#page-arranger[data-arranger-open="true"]';

async function checkPhone(browser) {
  console.log('phone 412x915, touch only:');
  const ctx = await browser.newContext({ viewport: { width: PHONE.width, height: PHONE.height }, deviceScaleFactor: PHONE.deviceScaleFactor, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openDocument(page);

  const toggle = await page.$('[data-arranger-toggle]');
  const box = await toggle.boundingBox();
  check('the toggle is reachable before opening', await toggleIsReachable(page, box));

  // The whole point: a *tap*, not a click. Touch is what was reported broken.
  const tapped = await tapOrFail(page, '[data-arranger-toggle]', 'tapping the toggle opens the drawer');
  const opened = tapped && (await page.waitForSelector(OPEN, { state: 'visible', timeout: 3_000 }).then(() => true, () => false));
  if (tapped) check('tapping the toggle opens the drawer', opened);
  if (!opened) {
    await ctx.close();
    return;
  }
  // Let the slide settle before measuring where it came to rest.
  await settle(page);

  const bar = await (await page.$('[data-top-bar]')).boundingBox();
  const drawer = await (await page.$('#page-arranger')).boundingBox();
  check(
    'the drawer starts below the top bar',
    drawer.y >= bar.y + bar.height - 1,
    `bar ends at ${Math.round(bar.y + bar.height)}, drawer starts at ${Math.round(drawer.y)}`,
  );
  check('the toggle is still reachable while the drawer is open', await toggleIsReachable(page, box));

  // It slides rather than appearing, and it is a transform so it stays on the
  // compositor instead of relaying out the thumbnail grid every frame.
  const motion = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('#page-arranger'));
    return { property: cs.transitionProperty, duration: cs.transitionDuration };
  });
  check(
    'the drawer transitions its transform',
    motion.property.includes('transform') && motion.duration !== '0s',
    `${motion.property} ${motion.duration}`,
  );

  // And the same tap closes it again, which is only possible because the bar
  // outranks the drawer.
  const closing = 'tapping the toggle again closes the drawer';
  if (await tapOrFail(page, '[data-arranger-toggle]', closing)) {
    check(closing, await page.waitForSelector(OPEN, { state: 'detached', timeout: 3_000 }).then(() => true, () => false));
    await page.tap('[data-arranger-toggle]');
    await page.waitForSelector(OPEN, { state: 'visible', timeout: 3_000 });
  }

  // The scrim is the other way out, and it must not cover the bar either. At
  // 412 px the drawer *is* the screen, so there is no scrim left to tap — the
  // small-tablet pass below does that half.
  const scrim = await (await page.$('[data-arranger-scrim]')).boundingBox();
  check('the scrim starts below the top bar', scrim.y >= bar.y + bar.height - 1, `scrim starts at ${Math.round(scrim.y)}`);
  check('the drawer fills the phone screen', Math.abs(drawer.width - PHONE.width) < 1, `${Math.round(drawer.width)}px`);

  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * 560 px: narrow enough for the scrim (it stops at Tailwind's `sm`, 640 px),
 * wide enough that the 440 px drawer leaves some of it exposed to tap.
 */
async function checkSmallTablet(browser) {
  console.log('small tablet 560x900, touch only:');
  const ctx = await browser.newContext({ viewport: { width: 560, height: 900 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await openDocument(page);
  const tapped = await tapOrFail(page, '[data-arranger-toggle]', 'tapping the toggle opens the drawer');
  const opened = tapped && (await page.waitForSelector(OPEN, { state: 'visible', timeout: 3_000 }).then(() => true, () => false));
  if (tapped) check('tapping the toggle opens the drawer', opened);
  if (!opened) {
    await ctx.close();
    return;
  }
  await settle(page);
  const drawer = await (await page.$('#page-arranger')).boundingBox();
  const scrim = await (await page.$('[data-arranger-scrim]')).boundingBox();
  const exposed = drawer.x - scrim.x;
  check('the drawer is a side panel, not the whole screen', Math.abs(drawer.width - 440) < 1, `${Math.round(drawer.width)}px`);
  check('the scrim is exposed beside the drawer', exposed > 8, `${Math.round(exposed)}px`);
  await page.touchscreen.tap(scrim.x + exposed / 2, scrim.y + scrim.height / 2);
  check('tapping the scrim closes the drawer', await page.waitForSelector(OPEN, { state: 'detached', timeout: 3_000 }).then(() => true, () => false));
  await ctx.close();
}

async function checkDesktop(browser) {
  console.log('desktop 1280x800:');
  const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  const page = await ctx.newPage();
  await openDocument(page);
  const clicked = await page
    .click('[data-arranger-toggle]', { timeout: 4_000 })
    .then(() => true, () => false);
  check(
    'clicking the toggle opens the drawer',
    clicked && (await page.waitForSelector(OPEN, { state: 'visible', timeout: 3_000 }).then(() => true, () => false)),
  );
  // Wide enough for a side panel: the page beside it stays live, so no scrim.
  const scrimVisible = await page.evaluate(() => {
    const el = document.querySelector('[data-arranger-scrim]');
    return el !== null && el.getBoundingClientRect().width > 0 && getComputedStyle(el).display !== 'none';
  });
  check('no scrim over the page on a wide viewport', !scrimVisible);
  await settle(page);
  const toggle = await (await page.$('[data-arranger-toggle]')).boundingBox();
  check('the toggle is still reachable while the drawer is open', await toggleIsReachable(page, toggle));
  await ctx.close();
}

/**
 * The Cloud Sync panel, which lives on the library screen rather than in a
 * document — so the arranger passes above never touch it.
 */
async function checkCloudPanel(browser) {
  console.log('cloud sync panel, 412x915, touch only:');
  const ctx = await browser.newContext({ viewport: { width: PHONE.width, height: PHONE.height }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-cloud-settings]', { timeout: 20_000 });

  const opened = await tapOrFail(page, '[data-cloud-settings]', 'tapping the cloud button opens the panel');
  if (!opened) {
    await ctx.close();
    return;
  }
  check('tapping the cloud button opens the panel', await page.waitForSelector('[data-cloud-panel]', { state: 'visible', timeout: 3_000 }).then(() => true, () => false));

  const account = await page.textContent('[data-cloud-account]');
  // A browser has no Rust side, and the panel must say *that* rather than
  // blaming a missing client id the visitor could not act on anyway.
  check('it explains that a browser cannot sync', (account ?? '').includes('desktop and Android'), account ?? '');
  check(
    'the sign-in button is present and disabled here',
    await page.$eval('[data-drive-sign-in]', (el) => el.disabled === true).catch(() => false),
  );
  check(
    'it names the folder and the narrow permission',
    await page.$eval('[data-cloud-panel]', (el) => el.textContent ?? '').then((t) => t.includes('Notex Sync') && t.includes('cannot see anything else')),
  );
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// --------------------------------------------------------------------- main

const executablePath = findChromium();
if (!executablePath) skip('no Chromium found (set CHROME_PATH or PLAYWRIGHT_BROWSERS_PATH)');

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  skip('playwright-core is not installed');
}

let server = null;
if (!(await isListening(PORT))) {
  if (urlArg) skip(`nothing is listening on ${BASE}`);
  if (!existsSync('dist/index.html')) skip('dist/ is missing — run `npm run build` first');
  server = spawn('node', ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], {
    stdio: 'ignore',
    detached: true,
  });
  if (!(await waitForServer(PORT))) {
    try { process.kill(-server.pid); } catch { /* already gone */ }
    skip(`vite preview never came up on ${BASE}`);
  }
}

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
try {
  await checkPhone(browser);
  await checkSmallTablet(browser);
  await checkDesktop(browser);
  await checkCloudPanel(browser);
} finally {
  await browser.close();
  if (server) {
    try { process.kill(-server.pid); } catch { /* already gone */ }
  }
}

console.log(failures === 0 ? '\nui-check: all checks passed' : `\nui-check: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
