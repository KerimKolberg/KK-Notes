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
// `--only=search,zoom` runs just the checks whose function name contains one of these.
const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',').filter(Boolean) ?? [];

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
    await page.$eval('[data-cloud-panel]', (el) => el.textContent ?? '').then((t) => t.includes('KK-Notes Sync') && t.includes('cannot see anything else')),
  );
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * A synthetic `.goodnotes` notebook: a stored-only ZIP holding one protobuf page
 * with two strokes in it.
 *
 * Built here rather than committed as a fixture because a real notebook is
 * somebody's notes. It is the same construction the unit tests use, which is the
 * point: this check is about the *surface* — that the summary is visible on a
 * phone, where the top-bar notice is not rendered at all — rather than about the
 * parsing, which the unit suite covers.
 */
function goodnotesFixture() {
  const varint = (n) => {
    const out = [];
    for (;;) {
      if (n < 0x80) return (out.push(n), out);
      out.push((n & 0x7f) | 0x80);
      n >>>= 7;
    }
  };
  const packFloats = (values) => {
    const buffer = new ArrayBuffer(values.length * 4);
    const view = new DataView(buffer);
    values.forEach((value, i) => view.setFloat32(i * 4, value, true));
    return [...new Uint8Array(buffer)];
  };
  const floatField = (field, values) => {
    const body = packFloats(values);
    return [...varint((field << 3) | 2), ...varint(body.length), ...body];
  };
  const nest = (field, body) => [...varint((field << 3) | 2), ...varint(body.length), ...body];

  const page = [];
  for (let s = 0; s < 2; s++) {
    const points = [];
    const pressures = [];
    for (let i = 0; i < 6; i++) {
      points.push(90 + s * 60 + i * 6, 140 + i * 20);
      pressures.push(0.3 + i * 0.1);
    }
    page.push(...nest(3, [...floatField(4, points), ...floatField(5, pressures), ...floatField(6, [0.1, 0.1, 0.1, 1])]));
  }

  const name = [...new TextEncoder().encode('notes/1.data')];
  const body = page;
  const u32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  const u16 = (n) => [n & 0xff, (n >> 8) & 0xff];
  const localHeader = [
    0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
    ...u32(body.length), ...u32(body.length), ...u16(name.length), ...u16(0), ...name,
  ];
  const central = [
    0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
    ...u32(body.length), ...u32(body.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
    ...u32(0), ...u32(0), ...name,
  ];
  const offset = localHeader.length + body.length;
  const end = [0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(1), ...u16(1), ...u32(central.length), ...u32(offset), ...u16(0)];
  return Buffer.from([...localHeader, ...body, ...central, ...end]);
}

/** Hand a file to the next picker the page opens. */
async function pickFile(page, selector, file) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5_000 }), page.click(selector)]);
  await chooser.setFiles(file);
}

/**
 * The GoodNotes import summary.
 *
 * Checked on a phone specifically. The import is inference and has to say what
 * it recovered, and the top bar's notice is `hidden … xl:flex` — so on the device
 * most likely to open a notebook, this dialog is the *only* thing that reports
 * the result. If it does not appear here, the feature silently lies.
 */
async function checkGoodNotesImport(browser) {
  console.log('goodnotes import summary, 412x915, touch only:');
  const ctx = await browser.newContext({ viewport: { width: PHONE.width, height: PHONE.height }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-open-file]', { timeout: 20_000 });

  // A file that is named like a notebook and is not one: the honest fallback.
  await pickFile(page, '[data-open-file]', {
    name: 'Chemistry.goodnotes',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('not a notebook at all'),
  });
  const failed = await page.waitForSelector('[data-goodnotes-report]', { state: 'visible', timeout: 5_000 }).then(() => true, () => false);
  check('a notebook that cannot be read says so in a dialog, not only in the top bar', failed);
  if (failed) {
    const message = await page.textContent('[data-report-message]');
    check('it says the file is not an archive', (message ?? '').includes('not a GoodNotes archive'), message ?? '');
    await page.click('[data-report-dismiss]');
    check(
      'dismissing it closes it',
      await page.waitForSelector('[data-goodnotes-report]', { state: 'detached', timeout: 3_000 }).then(() => true, () => false),
    );
  }

  // And a notebook that can be read: the summary over the document it opened.
  await page.waitForSelector('[data-open-file]', { timeout: 5_000 });
  await pickFile(page, '[data-open-file]', {
    name: 'Week 3.goodnotes',
    mimeType: 'application/octet-stream',
    buffer: goodnotesFixture(),
  });
  const imported = await page.waitForSelector('[data-report-counts]', { state: 'visible', timeout: 8_000 }).then(() => true, () => false);
  check('a readable notebook reports what came in', imported);
  if (imported) {
    const counts = await page.textContent('[data-report-counts]');
    check('it counts the pages and strokes it recovered', /1 page and 2 strokes/.test(counts ?? ''), counts ?? '');
    const warnings = await page.textContent('[data-report-warnings]');
    check('it admits everything came in as pen', (warnings ?? '').includes('came in as pen strokes'), (warnings ?? '').slice(0, 80));
    // Over the document, since a successful import navigates there.
    const box = await page.$eval('[data-goodnotes-report]', (el) => el.getBoundingClientRect().width);
    check('the summary is on screen at phone width', box > 0 && box <= PHONE.width, `${Math.round(box)}px`);
  }
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * Dropped files.
 *
 * Synthesised `DataTransfer`s rather than a real OS drag, which Playwright
 * cannot perform — so this checks the handlers and, more importantly, that the
 * *default action is prevented* everywhere. An unhandled file drop makes the
 * webview navigate to the file and replaces the whole app, and every pixel
 * outside the page stage used to be such a target.
 */
async function checkFileDrop(browser) {
  console.log('file drop, 1280x800:');
  const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-library-view]', { timeout: 20_000 });

  /** A DataTransfer carrying one named file, built in the page. */
  const fileTransfer = (name, bytes) =>
    page.evaluateHandle(
      ({ name, bytes }) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(bytes)], name, { type: 'application/octet-stream' }));
        return transfer;
      },
      { name, bytes },
    );

  /** A DataTransfer carrying the library's own move payload. */
  const entryTransfer = () =>
    page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.setData('text/notes-entry', '/Week 1.notex');
      return transfer;
    });

  // The guard: a file dragged over any part of the window must have its default
  // prevented, or the drop navigates away instead of arriving.
  const prevented = await page.evaluate(async () => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([1, 2, 3])], 'x.pdf', { type: 'application/pdf' }));
    const event = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer });
    document.querySelector('header')?.dispatchEvent(event);
    return event.defaultPrevented;
  });
  check('a file dragged over the header is not left to the webview', prevented);

  const entryLeftAlone = await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.setData('text/notes-entry', '/Week 1.notex');
    const event = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer });
    document.querySelector('header')?.dispatchEvent(event);
    return event.defaultPrevented;
  });
  check("the library's own drag is left alone, so moving notes still works", entryLeftAlone === false);

  // A file the library cannot open says so rather than doing nothing. Checked
  // *before* the import below, because a successful one leaves for the document
  // view and there is no library left to drop on.
  const photo = await fileTransfer('holiday.png', [0x89, 0x50, 0x4e, 0x47]);
  await page.dispatchEvent('[data-library-view]', 'dragover', { dataTransfer: photo });
  await page.dispatchEvent('[data-library-view]', 'drop', { dataTransfer: photo });
  const notice = await page
    .waitForSelector('[data-library-notice]', { state: 'visible', timeout: 3_000 })
    .then((el) => el.textContent(), () => null);
  check('a file it cannot open is named, not ignored', (notice ?? '').includes('holiday.png'), notice ?? 'no notice');

  // Drop feedback, then a real notebook, dropped.
  const dragging = await fileTransfer('Week 3.goodnotes', [...goodnotesFixture()]);
  await page.dispatchEvent('[data-library-view]', 'dragenter', { dataTransfer: dragging });
  await page.dispatchEvent('[data-library-view]', 'dragover', { dataTransfer: dragging });
  check(
    'dragging a file over the library marks it as a drop target',
    await page.waitForSelector('[data-library-drop-target]', { state: 'visible', timeout: 2_000 }).then(() => true, () => false),
  );
  await page.dispatchEvent('[data-library-view]', 'drop', { dataTransfer: dragging });
  const imported = await page.waitForSelector('[data-report-counts]', { state: 'visible', timeout: 8_000 }).then(() => true, () => false);
  check('dropping a notebook on the library opens it', imported);
  if (imported) {
    const counts = await page.textContent('[data-report-counts]');
    check('it is the same import the Open button performs', /1 page and 2 strokes/.test(counts ?? ''), counts ?? '');
    await page.click('[data-report-dismiss]');
    // A dropped document opens it, which means leaving the library behind.
    check(
      'opening it leaves the library for the document',
      await page.waitForSelector('[data-library-view]', { state: 'detached', timeout: 3_000 }).then(() => true, () => false),
    );
  }

  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * Tabs.
 *
 * Driven through the real drop path, because the interesting claim is the one
 * the user asked for: dropping a second document must *not* replace the first.
 * So this drops two notebooks and checks both are still open afterwards, and
 * that the strip appears only once there is more than one.
 */
async function checkTabs(browser) {
  console.log('tabs, 1280x800:');
  const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-library-view]', { timeout: 20_000 });

  const drop = async (name) => {
    const transfer = await page.evaluateHandle(
      ({ name, bytes }) => {
        const t = new DataTransfer();
        t.items.add(new File([new Uint8Array(bytes)], name, { type: 'application/octet-stream' }));
        return t;
      },
      { name, bytes: [...goodnotesFixture()] },
    );
    // The element that *has* the handler, since a synthesised event dispatched on
    // a descendant is not guaranteed to bubble to it.
    const target = (await page.$('[data-library-view]')) ? '[data-library-view]' : '[data-page-stage]';
    await page.dispatchEvent(target, 'dragover', { dataTransfer: transfer });
    await page.dispatchEvent(target, 'drop', { dataTransfer: transfer });
    await page.waitForSelector('[data-report-dismiss]', { state: 'visible', timeout: 8_000 }).catch(() => undefined);
    await page.click('[data-report-dismiss]').catch(() => undefined);
  };

  await drop('First.goodnotes');
  check(
    'one document open shows no strip',
    (await page.$('[data-tab-strip]')) === null,
    'a strip for a single tab wastes a row',
  );

  await drop('Second.goodnotes');
  const strip = await page.waitForSelector('[data-tab-strip]', { state: 'visible', timeout: 5_000 }).then(() => true, () => false);
  check('a second document opens a tab rather than replacing the first', strip);
  if (!strip) {
    check('no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
    return;
  }

  const titles = await page.$$eval('[data-tab] [role="tab"]', (els) => els.map((el) => el.textContent?.trim() ?? ''));
  check('both documents are listed', titles.length === 2, titles.join(' | '));
  check('the newest is the active one', await page.$eval('[data-tab-active] [role="tab"]', (el) => el.textContent ?? '').then((t) => t.includes('Second')));

  // Switching back must bring the first document's own pages with it.
  await page.click('[data-tab]:not([data-tab-active]) [role="tab"]');
  check(
    'clicking a tab switches to it',
    await page
      .$eval('[data-tab-active] [role="tab"]', (el) => el.textContent ?? '')
      .then((t) => t.includes('First'), () => false),
  );

  // An imported notebook has never been saved, so closing it asks — with three
  // answers, not two: losing the work and keeping the tab forever are both wrong.
  await page.click('[data-tab]:not([data-tab-active]) [data-tab-close]');
  const asked = await page
    .waitForSelector('[data-close-tab-dialog]', { state: 'visible', timeout: 3_000 })
    .then(() => true, () => false);
  check('closing a tab with unsaved changes asks first', asked);
  if (asked) {
    const labels = await page.$$eval('[data-close-tab-dialog] button', (els) => els.map((el) => el.textContent?.trim()));
    check('it offers cancel, discard and save', labels.join('|') === 'Cancel|Discard|Save and close', labels.join('|'));

    await page.click('[data-close-cancel]');
    check(
      'cancelling keeps both tabs',
      await page.$$eval('[data-tab]', (els) => els.length === 2),
    );

    await page.click('[data-tab]:not([data-tab-active]) [data-tab-close]');
    await page.waitForSelector('[data-close-tab-dialog]', { state: 'visible', timeout: 3_000 });
    await page.click('[data-close-discard]');
  }
  check(
    'discarding leaves one document and hides the strip',
    await page.waitForSelector('[data-tab-strip]', { state: 'detached', timeout: 3_000 }).then(() => true, () => false),
  );

  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * The reference pane: a second document beside the editor, to read from.
 *
 * What matters here is that the editor keeps its own document while the pane
 * shows another — and that the pane is a *rasterised* view, with no canvases or
 * handlers of its own, which is what keeps the pen's latency out of it.
 */
async function checkSplit(browser) {
  console.log('reference pane, 1280x800:');
  const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-library-view]', { timeout: 20_000 });

  const drop = async (name) => {
    const transfer = await page.evaluateHandle(
      ({ name, bytes }) => {
        const t = new DataTransfer();
        t.items.add(new File([new Uint8Array(bytes)], name, { type: 'application/octet-stream' }));
        return t;
      },
      { name, bytes: [...goodnotesFixture()] },
    );
    const target = (await page.$('[data-library-view]')) ? '[data-library-view]' : '[data-page-stage]';
    await page.dispatchEvent(target, 'dragover', { dataTransfer: transfer });
    await page.dispatchEvent(target, 'drop', { dataTransfer: transfer });
    await page.waitForSelector('[data-report-dismiss]', { state: 'visible', timeout: 8_000 }).catch(() => undefined);
    await page.click('[data-report-dismiss]').catch(() => undefined);
  };

  await drop('Exercises.goodnotes');
  await drop('Answers.goodnotes');
  await page.waitForSelector('[data-tab-strip]', { state: 'visible', timeout: 5_000 });

  const splitButton = '[data-tab]:not([data-tab-active]) [data-tab-split]';
  check('an inactive tab offers to open beside the editor', (await page.$(splitButton)) !== null);
  await page.click(splitButton);
  const shown = await page.waitForSelector('[data-reference-pane]', { state: 'visible', timeout: 5_000 }).then(() => true, () => false);
  check('it opens a reference pane', shown);
  if (!shown) {
    check('no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
    return;
  }

  check(
    'the pane shows the other document, not the one being edited',
    await page.$eval('[data-reference-title]', (el) => el.textContent ?? '').then((t) => t.includes('Exercises')),
  );
  check(
    'the editor still holds its own document',
    await page
      .$eval('[data-tab-active] [role="tab"]', (el) => el.textContent ?? '')
      .then((t) => t.includes('Answers')),
  );
  check('the pane renders pages', (await page.$$('[data-reference-page-frame]')).length > 0);
  // The point of the design: no live canvases and no handlers in the pane.
  check(
    'the pane draws one texture per page, not a layer stack',
    await page.$$eval('[data-reference-page-frame]', (frames) =>
      frames.every((frame) => frame.querySelectorAll('canvas').length === 1),
    ),
  );

  // Both documents on screen, so both must stay in memory — and the divider moves.
  const before = await page.$eval('[data-page-stage]', (el) => el.getBoundingClientRect().width);
  const divider = await page.$('[data-split-divider]');
  const box = await divider.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 180, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const after = await page.$eval('[data-page-stage]', (el) => el.getBoundingClientRect().width);
  check('the divider resizes the editor', after < before - 60, `${Math.round(before)} → ${Math.round(after)}`);

  await page.click('[data-reference-close]');
  check(
    'closing the pane leaves the editor alone',
    await page.waitForSelector('[data-reference-pane]', { state: 'detached', timeout: 3_000 }).then(() => true, () => false),
  );
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * The toolbar: dragging it, docking it, and what it costs to move.
 *
 * Reported from a real tablet: the toolbar lagged when dragged in fullscreen, and
 * could not be moved to the sides. Both are layout and paint behaviour that a
 * node test cannot see, so this drives it in Chromium — at desktop size, where
 * the toolbar is a floating bar and a side dock is a real change of shape.
 */
async function checkToolbar(browser) {
  console.log('toolbar, 1280x800:');
  const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openDocument(page);
  await page.waitForSelector('[data-tool-palette]', { state: 'visible', timeout: 10_000 });

  const info = () =>
    page.$eval('[data-tool-palette]', (el) => {
      const r = el.getBoundingClientRect();
      const host = el.offsetParent.getBoundingClientRect();
      return {
        dock: el.getAttribute('data-dock'),
        vertical: el.getAttribute('data-vertical'),
        orientation: el.getAttribute('aria-orientation'),
        x: r.left - host.left,
        y: r.top - host.top,
        w: r.width,
        h: r.height,
        hostW: host.width,
        hostH: host.height,
        blur: getComputedStyle(el).backdropFilter,
      };
    });

  const start = await info();
  check('the toolbar starts docked to the bottom', start.dock === 'bottom', start.dock);
  check('it is a horizontal bar', start.orientation === 'horizontal' && start.h < 200, `${Math.round(start.w)}x${Math.round(start.h)}`);
  check(
    'it has no backdrop blur to re-composite while it moves',
    start.blur === 'none' || start.blur === '',
    start.blur,
  );

  // Drag by the handle. While the pointer is down, the panel must be moved with a
  // transform, not with left/top — that is the whole reason it is cheap.
  const handle = await (await page.$('[data-palette-handle]')).boundingBox();
  const hx = handle.x + handle.width / 2;
  const hy = handle.y + handle.height / 2;
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  const leftBefore = await page.$eval('[data-tool-palette]', (el) => el.style.left);
  await page.mouse.move(hx - 300, hy - 250, { steps: 6 });
  const mid = await page.$eval('[data-tool-palette]', (el) => ({
    transform: el.style.transform,
    left: el.style.left,
    willChange: getComputedStyle(el).willChange,
  }));
  check('mid-drag it moves by transform', mid.transform.startsWith('translate3d'), mid.transform);
  check('mid-drag left/top are untouched, so nothing lays out', mid.left === leftBefore, `${leftBefore} -> ${mid.left}`);
  check('mid-drag it is promoted to its own layer', mid.willChange === 'transform', mid.willChange);

  // Pushing the pointer against the left edge shows where it would dock.
  const box = await page.$eval('[data-tool-palette]', (el) => el.offsetParent.getBoundingClientRect().toJSON());
  await page.mouse.move(box.left + 10, box.top + box.height / 2, { steps: 6 });
  check(
    'pushing towards an edge shows the dock target',
    await page.waitForSelector('[data-dock-target="left"]', { state: 'visible', timeout: 2_000 }).then(() => true, () => false),
  );
  await page.mouse.up();

  const left = await info();
  check('released against the left edge, it docks there', left.dock === 'left', left.dock);
  check('docked left it stands on end', left.orientation === 'vertical' && left.vertical === 'true', left.orientation);
  check('it sits against the left edge', left.x < 24, `x=${Math.round(left.x)}`);
  check('it fits inside the stage, wrapping rather than overflowing', left.y >= 0 && left.y + left.h <= left.hostH, `y=${Math.round(left.y)} h=${Math.round(left.h)} of ${Math.round(left.hostH)}`);
  check('the dock target goes away once released', (await page.$('[data-dock-target]')) === null);

  // Standing on end it must not take the width of a whole row of colours with it:
  // the colours and the thickness stack in a narrow column beside the tools.
  check('docked left it is a slim column, not a wide panel', left.w <= 130, `${Math.round(left.w)}px wide`);
  // Everything in the colour column stays inside the column. Tooltips are left out:
  // they are meant to hang beside the toolbar, and the mouse is often on a button.
  const fits = () =>
    page.evaluate(() => {
      const config = document.querySelector('[data-tool-config]').getBoundingClientRect();
      const panel = document.querySelector('[data-tool-palette]').getBoundingClientRect();
      const outside = [];
      for (const el of document.querySelectorAll('[data-tool-config] *')) {
        if (el.closest('[role="tooltip"]') || el.classList.contains('sr-only')) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.left < config.left - 0.5 || r.right > config.right + 0.5) {
          outside.push(`${el.getAttribute('data-swatch') ?? el.tagName} ${Math.round(r.right - config.right)}px over`);
        }
      }
      return { outside, columnInsidePanel: config.left >= panel.left && config.right <= panel.right, width: Math.round(config.width) };
    });
  const stacked = await fits();
  check('every colour and the slider stay inside it', stacked.outside.length === 0 && stacked.columnInsidePanel, JSON.stringify(stacked));
  // The colours stand in one column, in the height the tools beside them leave free.
  const swatches = await page.$$eval('[data-swatch]', (els) => els.map((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y) }; }));
  check('the colours stand in a single column', swatches.length >= 8 && swatches.every((p) => Math.abs(p.x - swatches[0].x) <= 1), JSON.stringify(swatches.map((p) => p.x)));
  check('running down the side of the tools', swatches.every((p, i) => i === 0 || p.y > swatches[i - 1].y), JSON.stringify(swatches.map((p) => p.y)));
  const slider = await page.$eval('[data-thickness]', (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
  check('and the thickness slider stands up beside them', slider.h > slider.w * 3, `${slider.w}x${slider.h}`);

  // The laser adds a Rainbow button and the swatch editor adds three, both wider
  // than a swatch; neither may push the column wider.
  await page.click('[data-palette-tool="laser-pointer"]');
  const laser = await fits();
  check('the laser\'s Rainbow button fits too', laser.outside.length === 0 && laser.columnInsidePanel, JSON.stringify(laser));
  const laserWidth = (await info()).w;
  check('and does not widen the toolbar', Math.abs(laserWidth - left.w) <= 1, `${Math.round(left.w)} -> ${Math.round(laserWidth)}`);
  await page.click('[data-palette-tool="pen"]');
  await page.keyboard.press('Escape');
  const swatch = await (await page.$('[data-swatch-index="1"]')).boundingBox();
  await page.mouse.move(swatch.x + swatch.width / 2, swatch.y + swatch.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  const editor = await page.waitForSelector('[data-swatch-editor]', { state: 'visible', timeout: 2_000 }).then(() => true, () => false);
  if (editor) {
    const editing = await fits();
    check('the swatch editor fits inside it', editing.outside.length === 0 && editing.columnInsidePanel, JSON.stringify(editing));
    await page.click('[data-swatch-done]');
  }

  // A flyout from a side dock opens beside the toolbar, not above a button that
  // may be at the top of the screen.
  // The pen is already the active tool, so one press opens its flyout; a second
  // would close it again.
  await page.click('[data-palette-tool="pen"]');
  const popover = await page.waitForSelector('[data-popover="Pen brushes"]', { state: 'visible', timeout: 3_000 }).then(() => true, () => false);
  check('a flyout opens from the side dock', popover);
  if (popover) {
    const geometry = await page.evaluate(() => {
      const pop = document.querySelector('[data-popover="Pen brushes"]').getBoundingClientRect();
      // Beside the button that owns it. The toolbar is wider than the tools — its
      // colours sit in a column of their own — so the button is the right anchor.
      const owner = document.querySelector('[data-palette-tool="pen"]').getBoundingClientRect();
      return { popLeft: pop.left, ownerRight: owner.right, top: pop.top, bottom: pop.bottom, vh: window.innerHeight };
    });
    check('it opens to the right of its button', geometry.popLeft >= geometry.ownerRight - 1, `${Math.round(geometry.popLeft)} vs ${Math.round(geometry.ownerRight)}`);
    check('and stays on screen', geometry.top >= 0 && geometry.bottom <= geometry.vh, `${Math.round(geometry.top)}..${Math.round(geometry.bottom)}`);
    await page.keyboard.press('Escape');
  }

  // Pinning. Unpinned, the toolbar gets out of the way after a few idle seconds and
  // leaves a tab on its edge; anything using it holds it up.
  const state = () =>
    page.$eval('[data-tool-palette]', (el) => ({
      pinned: el.getAttribute('data-pinned'),
      concealed: el.getAttribute('data-concealed') === 'true',
      visibility: getComputedStyle(el).visibility,
      pressed: el.querySelector('[data-palette-pin]')?.getAttribute('aria-pressed'),
    }));
  const pinned = await state();
  check('the toolbar starts pinned', pinned.pinned === 'true' && pinned.pressed === 'true', JSON.stringify(pinned));
  await page.click('[data-palette-pin]');
  const unpinned = await state();
  check('the pin button unpins it', unpinned.pinned === 'false' && unpinned.pressed === 'false', JSON.stringify(unpinned));
  // Pointer over it (the click left it there): it stays up however long that is.
  await page.waitForTimeout(6_500);
  check('while the pointer is on it, it stays', !(await state()).concealed);
  await page.mouse.move(700, 300);
  await page.waitForTimeout(2_500);
  check('it does not vanish the moment the pointer leaves', !(await state()).concealed);
  const hidden = await page
    .waitForSelector('[data-tool-palette][data-concealed="true"]', { state: 'attached', timeout: 6_000 })
    .then(() => true, () => false);
  check('after a few idle seconds it slips away', hidden);
  await page.waitForTimeout(350);
  check('and cannot be tabbed to or tapped', (await state()).visibility === 'hidden');
  const tab = await page.$('[data-palette-reveal]');
  check('a tab is left on its edge', tab !== null);
  if (tab) {
    const t = await page.$eval('[data-palette-reveal]', (el) => {
      const r = el.getBoundingClientRect();
      const host = el.offsetParent.getBoundingClientRect();
      return { edge: el.getAttribute('data-palette-reveal'), x: r.left - host.left, midY: r.top - host.top + r.height / 2, hostH: host.height };
    });
    check('on the edge it is docked to, in the middle', t.edge === 'left' && t.x < 4 && Math.abs(t.midY - t.hostH / 2) < 4, JSON.stringify(t));
    // A pen hovers over the page all the time it writes, and a finger reports
    // "enter" as it lands; neither may pop the toolbar up over the work.
    await page.$eval('[data-palette-reveal]', (el) => {
      for (const pointerType of ['pen', 'touch']) {
        el.dispatchEvent(new PointerEvent('pointerover', { pointerType, bubbles: true, relatedTarget: document.body }));
      }
    });
    await page.waitForTimeout(250);
    check('a pen hovering over the tab, or a touch landing on it, does not bring the toolbar up', (await state()).concealed);
    await page.hover('[data-palette-reveal]');
    const back = await page
      .waitForSelector('[data-tool-palette]:not([data-concealed])', { timeout: 2_000 })
      .then(() => true, () => false);
    check('pointing at the tab with a mouse brings the toolbar back', back);
    await page.waitForTimeout(350);
    check('and it is usable again', (await state()).visibility === 'visible');
    check('the tab goes away with it', (await page.$('[data-palette-reveal]')) === null);
  }

  // An open flyout is in use even with the pointer somewhere else entirely.
  await page.click('[data-palette-tool="pen"]');
  await page.waitForSelector('[data-popover="Pen brushes"]', { state: 'visible', timeout: 3_000 });
  await page.mouse.move(700, 300);
  await page.waitForTimeout(6_500);
  check(
    'an open flyout holds the toolbar up',
    !(await state()).concealed && (await page.$('[data-popover="Pen brushes"]')) !== null,
  );
  await page.keyboard.press('Escape');
  await page.mouse.move(701, 301);
  check(
    'once it is closed the toolbar goes again',
    await page
      .waitForSelector('[data-tool-palette][data-concealed="true"]', { state: 'attached', timeout: 8_000 })
      .then(() => true, () => false),
  );

  // The keyboard reaches the tab too, and lands on the toolbar it brings back.
  await page.focus('[data-palette-reveal]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-tool-palette]:not([data-concealed])', { timeout: 2_000 });
  await page.waitForTimeout(400);
  check(
    'the keyboard brings it back and moves focus onto it',
    await page.evaluate(() => document.querySelector('[data-tool-palette]').contains(document.activeElement)),
  );
  await page.click('[data-palette-pin]');
  check('pinning it again keeps it', (await state()).pinned === 'true');

  // The pointer over a page: the built-in crosshair, made a quarter smaller.
  const cursorOf = () => page.$eval('[data-layer="live"]', (el) => getComputedStyle(el).cursor);
  const cursor = await cursorOf();
  const url = /url\("?([^")]+)"?\)/.exec(cursor)?.[1] ?? '';
  const size = Number(/width='(\d+)'/.exec(decodeURIComponent(url))?.[1] ?? Number.NaN);
  check('the pen shows a custom pointer', url.startsWith('data:image/svg+xml'), cursor.slice(0, 60));
  check('it is 24 px — three quarters of the 32 px crosshair', size === 24, `${size}px`);
  check('the system crosshair is still the fallback', /crosshair\s*$/.test(cursor));
  await page.click('[data-palette-tool="eraser"]');
  // Hovering with an eraser used to show nothing on a page — `cursor: none`, with a ring
  // drawn only while erasing — so the pointer vanished as it crossed onto the page.
  const ring = await cursorOf();
  check('the eraser shows a ring as the pointer, not nothing', ring !== 'none' && decodeURIComponent(ring).includes('<circle'), ring.slice(0, 50));
  check('and it is not the pen\'s cross', ring !== cursor);
  await page.click('[data-palette-tool="pen"]');
  await page.keyboard.press('Escape');

  // The settings panel holds more than a small window is tall. It must scroll
  // rather than run off the top, or its first rows cannot be reached at all.
  await page.click('[data-palette-settings-trigger]');
  await page.waitForSelector('[data-palette-settings]', { state: 'visible', timeout: 3_000 });
  const panel = await page.$eval('[data-palette-settings]', (el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, vh: window.innerHeight, scrolls: el.scrollHeight > el.clientHeight, overflowY: getComputedStyle(el).overflowY };
  });
  check('the settings panel fits inside the window', panel.top >= 0 && panel.bottom <= panel.vh, `${Math.round(panel.top)}..${Math.round(panel.bottom)} of ${panel.vh}`);
  check('and scrolls when it has more than fits', panel.overflowY === 'auto' && panel.scrolls, `overflow-y ${panel.overflowY}, scrolls ${panel.scrolls}`);
  await page.keyboard.press('Escape');

  // Choosing an edge from the settings needs no dragging at all, which matters
  // with a pen in one hand and a target a few pixels wide.
  await page.click('[data-palette-settings-trigger]');
  await page.waitForSelector('[data-palette-dock-choice="top"]', { state: 'visible', timeout: 3_000 });
  await page.click('[data-palette-dock-choice="top"]');
  const top = await info();
  check('the settings can dock it to the top', top.dock === 'top' && top.orientation === 'horizontal' && top.y < 40, `${top.dock} y=${Math.round(top.y)}`);

  await page.click('[data-palette-dock-choice="bottom"]');
  const back = await info();
  check('and back to the bottom', back.dock === 'bottom' && back.y > back.hostH / 2, `${back.dock} y=${Math.round(back.y)}`);

  // The dock is remembered.
  await page.click('[data-palette-dock-choice="right"]');
  await page.keyboard.press('Escape');
  await page.click('[data-palette-pin]');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-new-document]', { timeout: 20_000 });
  await page.click('[data-new-document]');
  await page.waitForSelector('[data-tool-palette]', { state: 'visible', timeout: 10_000 });
  const remembered = await info();
  check('the dock survives a restart', remembered.dock === 'right', remembered.dock);
  check('so does being unpinned', (await state()).pinned === 'false');

  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * A fresh document with a synthetic pen on it. `stylus` overrides the saved button
 * mapping. Events carry `buttons` as Windows reports them, and go to the live canvas
 * of the first page (or to `on(element, points, buttons)` for anything else).
 */
async function openPenDocument(browser, stylus, contextOptions = {}) {
  const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height }, ...contextOptions });
  if (stylus) {
    await ctx.addInitScript((value) => {
      try { localStorage.setItem('notes.preferences.v1', JSON.stringify({ stylus: value })); } catch { /* none */ }
    }, stylus);
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openDocument(page);
  await page.waitForSelector('[data-layer="live"]', { state: 'attached', timeout: 10_000 });
  await page.evaluate(() => {
    const canvas = () => document.querySelector('[data-layer="live"]');
    const fire = (type, x, y, buttons, button) => {
      canvas().dispatchEvent(
        new PointerEvent(type, {
          pointerType: 'pen', pointerId: 7, isPrimary: true, bubbles: true, cancelable: true,
          clientX: x, clientY: y, buttons, button, pressure: buttons & 1 ? 0.5 : 0,
        }),
      );
    };
    window.__pen = {
      hover: (x, y, buttons = 0) => fire('pointermove', x, y, buttons, -1),
      stroke: async (points, buttons) => {
        fire('pointerdown', points[0][0], points[0][1], buttons, 0);
        for (const [x, y] of points.slice(1)) {
          fire('pointermove', x, y, buttons, -1);
          await new Promise((r) => setTimeout(r, 6));
        }
        const last = points[points.length - 1];
        fire('pointerup', last[0], last[1], 0, 0);
      },
      // A drag on some other element (a selection handle), one move per frame.
      drag: async (selector, points) => {
        const send = (type, x, y, buttons, button) =>
          document.querySelector(selector).dispatchEvent(
            new PointerEvent(type, {
              pointerType: 'pen', pointerId: 9, isPrimary: true, bubbles: true, cancelable: true,
              clientX: x, clientY: y, buttons, button, pressure: buttons & 1 ? 0.5 : 0,
            }),
          );
        send('pointerdown', points[0][0], points[0][1], 1, 0);
        for (const [x, y] of points.slice(1)) {
          send('pointermove', x, y, 1, -1);
          await new Promise((r) => requestAnimationFrame(() => r()));
        }
        const last = points[points.length - 1];
        send('pointerup', last[0], last[1], 0, 0);
      },
      ink: () => {
        const c = document.querySelector('[data-layer="committed"]');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
        return n;
      },
    };
  });
  const r = await page.$eval('[data-layer="live"]', (el) => el.getBoundingClientRect().toJSON());
  const cx = r.x + r.width / 2;
  const cy = r.y + 200;
  const line = Array.from({ length: 40 }, (_, i) => [cx - 150 + i * 7.5, cy]);
  const around = (rx, ry, y = cy) =>
    Array.from({ length: 31 }, (_, i) => [cx + rx * Math.cos((i * 12 * Math.PI) / 180), y + ry * Math.sin((i * 12 * Math.PI) / 180)]);
  const tool = () => page.$eval('[data-palette-tool][aria-pressed="true"]', (el) => el.getAttribute('data-palette-tool')).catch(() => 'none');
  const selected = () => page.$('[data-selection-box]').then((x) => x !== null);
  return { ctx, page, errors, cx, cy, line, around, tool, selected };
}

/**
 * Where the colours and the tools stand on each dock. The tools are against the
 * edge the bar is docked to and the colours on the side facing the page, so the
 * right dock mirrors the left and the bottom mirrors the top; standing on end, the
 * settings button heads the column of colours rather than ending the tools.
 */
async function checkDocks(browser) {
  console.log('dock layouts, 1280x800:');
  const geometry = async (dock) => {
    const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
    await ctx.addInitScript((d) => localStorage.setItem('notes.preferences.v1', JSON.stringify({ paletteDock: d })), dock);
    const page = await ctx.newPage();
    await openDocument(page);
    await page.waitForSelector('[data-tool-palette]', { state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(300);
    const found = await page.evaluate(() => {
      const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; };
      const swatches = [...document.querySelectorAll('[data-swatch]')].map((el) => box(el));
      return {
        settings: box(document.querySelector('[data-palette-settings-trigger]')),
        pen: box(document.querySelector('[data-palette-tool="pen"]')),
        config: box(document.querySelector('[data-tool-config]')),
        swatches,
        panel: box(document.querySelector('[data-tool-palette]')),
      };
    });
    await ctx.close();
    return found;
  };

  const left = await geometry('left');
  check('left: the settings button sits over the colours, in their column', Math.abs(left.settings.cx - left.swatches[0].cx) <= 2 && left.settings.b <= left.swatches[0].t, `${Math.round(left.settings.cx)} vs ${Math.round(left.swatches[0].cx)}`);
  check('left: the tools are on the outside, the colours on the inside', left.pen.cx < left.swatches[0].cx);
  check('left: the colours fill the height the tools leave, not a third column', left.panel.r - left.swatches[0].r < 20, `${Math.round(left.panel.r - left.swatches[0].r)}px to the edge`);

  const right = await geometry('right');
  check('right: the settings button sits over the colours too', Math.abs(right.settings.cx - right.swatches[0].cx) <= 2 && right.settings.b <= right.swatches[0].t);
  check('right: the tools are on the outside (right), the colours on the inside', right.pen.cx > right.swatches[0].cx);
  check('right mirrors left', Math.abs((left.pen.l - left.panel.l) - (right.panel.r - right.pen.r)) <= 2 && Math.abs((left.swatches[0].l - left.panel.l) - (right.panel.r - right.swatches[0].r)) <= 2, JSON.stringify({ l: left.pen.l - left.panel.l, r: right.panel.r - right.pen.r }));

  const top = await geometry('top');
  const bottom = await geometry('bottom');
  check('top: the tools are on the edge, the colours below them', top.pen.cy < top.swatches[0].cy);
  check('bottom: the tools are on the edge, the colours above them', bottom.pen.cy > bottom.swatches[0].cy);
  check('top mirrors bottom', Math.abs((top.pen.t - top.panel.t) - (bottom.panel.b - bottom.pen.b)) <= 2 && Math.abs((top.swatches[0].t - top.panel.t) - (bottom.panel.b - bottom.swatches[0].b)) <= 2);
  check('on a row the settings button stays with the tools', top.settings.cy === top.pen.cy || Math.abs(top.settings.cy - top.pen.cy) <= 2);
}

/**
 * The pen's buttons, driven with real handlers.
 *
 * Reported from a tablet: "the shortcut is not working". The node tests said the
 * mapping resolved to the right tool, and it did — but a lasso taken by a held
 * button left a selection nobody could see, because the selection only lives while
 * the lasso is the active tool. That is a gap between a decision and what the page
 * does with it, which only a page can show. Pen events are synthesised (no browser
 * can be handed an eraser-flag button any other way) and carry `buttons` exactly as
 * Windows reports them: 2 the barrel, 32 the eraser flag, 1 the tip.
 */
async function checkPenButtons(browser) {
  console.log('pen buttons, 1280x800:');

  const open = (stylus) => openPenDocument(browser, stylus);

  // --- the shipped mapping: barrel hold = stroke eraser, second button = lasso
  {
    const { ctx, page, errors, cx, cy, line, around, tool, selected } = await open();
    await page.evaluate(([pts]) => window.__pen.stroke(pts, 1), [line]);
    const inked = await page.evaluate(() => window.__pen.ink());
    check('a pen stroke leaves ink', inked > 0, String(inked));

    await page.evaluate(([x, y]) => window.__pen.hover(x, y, 2), [cx, cy - 100]);
    await page.waitForTimeout(450);
    check('holding the barrel button (hovering) borrows the eraser', (await tool()) === 'eraser', await tool());
    await page.evaluate(([x, y]) => window.__pen.hover(x, y, 0), [cx, cy - 100]);
    await page.waitForTimeout(100);
    check('and letting go gives the pen back', (await tool()) === 'pen', await tool());

    // The second button, held, with a loop drawn round the stroke.
    await page.evaluate(([pts]) => window.__pen.stroke(pts, 33), [around(190, 60)]);
    await page.waitForTimeout(300);
    check('the second button lassos: the selection is shown', await selected());
    check('and the lasso is the active tool while there is a selection', (await tool()) === 'lasso', await tool());
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    check('dismissing the selection gives the pen back', (await tool()) === 'pen' && !(await selected()), `${await tool()}, selected ${await selected()}`);

    // A loop round nothing leaves nothing behind, and the pen comes straight back.
    await page.evaluate(([pts]) => window.__pen.stroke(pts, 33), [around(60, 30, cy + 300)]);
    await page.waitForTimeout(300);
    check('a loop round nothing gives the pen back at once', (await tool()) === 'pen' && !(await selected()), `${await tool()}, selected ${await selected()}`);

    // Barrel held with the tip on the page erases what it crosses.
    await page.evaluate(([pts]) => window.__pen.stroke(pts, 3), [line]);
    await page.waitForTimeout(200);
    check('the barrel button with the tip down erases', (await page.evaluate(() => window.__pen.ink())) === 0);
    check('the pen is still the pen afterwards', (await tool()) === 'pen', await tool());
    check('no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // --- the barrel hold mapped to the lasso, which is the case the original design named
  {
    const { ctx, page, errors, cx, cy, line, around, tool, selected } = await open({
      clickToggle: ['pen', 'eraser-stroke'], holdTool: 'lasso', eraserEnd: 'lasso',
    });
    await page.evaluate(([pts]) => window.__pen.stroke(pts, 1), [line]);
    await page.evaluate(([x, y]) => window.__pen.hover(x, y, 2), [cx, cy - 100]);
    await page.waitForTimeout(450);
    check('the barrel hold can be the lasso', (await tool()) === 'lasso', await tool());
    await page.evaluate(([pts]) => window.__pen.stroke(pts, 3), [around(190, 60)]);
    // Let go of the button after the loop, as a hand does.
    await page.evaluate(([x, y]) => window.__pen.hover(x, y, 0), [cx, cy - 100]);
    await page.waitForTimeout(300);
    check('the selection survives the button being let go', await selected());
    check('with the lasso still active to use it', (await tool()) === 'lasso', await tool());
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    check('and the pen returns when it is dismissed', (await tool()) === 'pen', await tool());

    // The performance overlay says what window it is measuring, so a "laggier in
    // fullscreen" report can be a comparison rather than an impression.
    await page.click('[data-palette-settings-trigger]');
    await page.click('[data-debug-mode]');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-debug-overlay]', { state: 'visible', timeout: 3_000 });
    await page.waitForTimeout(600);
    const overlay = await page.$eval('[data-debug-overlay]', (el) => el.textContent ?? '');
    check('the overlay names the viewport it is measuring', overlay.includes(`${DESKTOP.width}×`) && overlay.includes('@1×'), overlay.slice(0, 120));
    check('and whether it is windowed or fullscreen', overlay.includes('windowed'), overlay.slice(0, 120));
    check('no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
}

/**
 * Stretching a lasso selection.
 *
 * Reported from a tablet: pulling a selected line out across the page was "buggy and
 * hard to pull". Reproduced with a pen on a thin line: the first move lurched (the
 * grab was not on the point the scale is measured from), a corner on a two-pixel-high
 * box scaled by the pen's wobble, and — the real fault — the handle being dragged was
 * removed from the page on the first move, which released the pen's capture, so the
 * stretch followed the pen only while it stayed inside the old box.
 */
async function checkLasso(browser) {
  console.log('lasso stretch, 1280x800:');
  const { ctx, page, errors, cx, cy, around } = await openPenDocument(browser);
  const box = () => page.$eval('[data-selection-box]', (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  const handles = () => page.$$eval('[data-selection-handle]', (els) => els.map((e) => e.getAttribute('data-selection-handle')).sort());

  // A straight, nearly flat line.
  const line = Array.from({ length: 30 }, (_, i) => [cx - 100 + i * (200 / 29), cy + (i / 29) * 3]);
  await page.evaluate(([pts]) => window.__pen.stroke(pts, 1), [line]);
  await page.click('[data-palette-tool="lasso"]');
  await page.evaluate(([pts]) => window.__pen.stroke(pts, 1), [around(140, 40)]);
  await page.waitForSelector('[data-selection-box]', { timeout: 3_000 });
  check('a line is offered only the handles that stretch it', JSON.stringify(await handles()) === '["e","w"]', JSON.stringify(await handles()));

  const before = await box();
  const start = { x: before.x + before.w + 4, y: before.y + before.h / 2 + 4 };
  // 300 px out to the right, with the pen wandering a few pixels as a hand does.
  const pull = Array.from({ length: 16 }, (_, i) => [start.x + i * 20, start.y + (i % 2 ? 3 : -2)]);
  const widths = [];
  const sample = setInterval(() => {}, 1000);
  clearInterval(sample);
  const dragging = page.evaluate(([pts]) => window.__pen.drag('[data-selection-handle="e"]', pts), [pull]);
  for (let i = 0; i < 14; i++) {
    await page.waitForTimeout(25);
    widths.push((await box().catch(() => ({ w: 0 }))).w);
  }
  await dragging;
  const during = await page.$$('[data-selection-handle]');
  const after = await box();
  check('the selection follows the pen the whole way out', after.w > before.w + 250, `${Math.round(before.w)} -> ${Math.round(after.w)}`);
  let biggestStep = 0;
  for (let i = 1; i < widths.length; i++) biggestStep = Math.max(biggestStep, Math.abs(widths[i] - widths[i - 1]));
  check('and grows steadily, without stalling or lurching', biggestStep < 90, `largest step ${Math.round(biggestStep)}px over ${widths.map((w) => Math.round(w)).join(', ')}`);
  check('the handle stays on the page for the length of the drag', during.length === 2, `${during.length} handles`);
  check('its height is left alone by an edge handle', Math.abs(after.h - before.h) < 4, `${Math.round(before.h)} -> ${Math.round(after.h)}`);

  // Pulled on past the edge of the page it stops there: the ink is cut off at the page
  // edge on screen, and a box that kept growing beyond it read as the stretch being stuck.
  const wall = await page.$eval('[data-page-index="0"]', (el) => el.getBoundingClientRect().right);
  const nowBox = await box();
  const farStart = { x: nowBox.x + nowBox.w + 4, y: nowBox.y + nowBox.h / 2 + 4 };
  const farPull = Array.from({ length: 14 }, (_, i) => [farStart.x + i * 90, farStart.y]);
  await page.evaluate(([pts]) => window.__pen.drag('[data-selection-handle="e"]', pts), [farPull]);
  const stopped = await box();
  check('pulled on past the edge of the page, the stretch stops at it', stopped.x + stopped.w <= wall + 14, `right edge ${Math.round(stopped.x + stopped.w)} against the page's ${Math.round(wall)}`);
  check('and it did reach the edge, rather than stopping short', stopped.x + stopped.w >= wall - 40, `${Math.round(stopped.x + stopped.w)} of ${Math.round(wall)}`);

  // A selection with some size to it: every handle, and no lurch when it is grabbed.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  await page.click('[data-palette-tool="pen"]');
  const x0 = cx - 60;
  const y0 = cy + 200;
  const square = [[x0, y0], [x0 + 120, y0], [x0 + 120, y0 + 90], [x0, y0 + 90], [x0, y0]].flatMap(([x, y], i, all) =>
    i === 0 ? [[x, y]] : Array.from({ length: 6 }, (_, k) => [all[i - 1][0] + ((x - all[i - 1][0]) * (k + 1)) / 6, all[i - 1][1] + ((y - all[i - 1][1]) * (k + 1)) / 6]),
  );
  await page.evaluate(([pts]) => window.__pen.stroke(pts, 1), [square]);
  await page.click('[data-palette-tool="lasso"]');
  await page.evaluate(([pts]) => window.__pen.stroke(pts, 1), [around(110, 80, y0 + 45)]);
  await page.waitForSelector('[data-selection-box]', { timeout: 3_000 });
  check('a selection with some size has all eight handles', (await handles()).length === 8, JSON.stringify(await handles()));

  const b1 = await box();
  const corner = await page.$eval('[data-selection-handle="se"]', (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  // Grab it eight pixels off centre (a pen does), move one pixel: nothing should jump.
  const grabX = corner.x + 8;
  const grabY = corner.y + 8;
  await page.evaluate(([pts]) => window.__pen.drag('[data-selection-handle="se"]', pts), [[[grabX, grabY], [grabX + 1, grabY + 1]]]);
  const b2 = await box();
  check('grabbing a handle off its centre does not make the selection jump', Math.abs(b2.w - b1.w) < 4 && Math.abs(b2.h - b1.h) < 4, `${Math.round(b1.w)}x${Math.round(b1.h)} -> ${Math.round(b2.w)}x${Math.round(b2.h)}`);

  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * The floating toolbar over a placed object (a sticky note; a text box's controls are in the format bar). It
 * wraps to two or three rows, and anchored by its top (as it was) it grew down over the object it was for; near
 * the top of the page it has to go underneath, and it can be pulled aside by its grip.
 */
async function checkTextToolbar(browser) {
  console.log('floating toolbar over a note, 1280x800:');
  const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openDocument(page);
  await page.waitForSelector('[data-insert-trigger]', { timeout: 10_000 });
  await page.click('[data-insert-trigger]');
  await page.click('[data-insert-note]');
  await page.waitForSelector('[data-media-toolbar]');
  const rects = () =>
    page.evaluate(() => {
      const r = (el) => { const b = el.getBoundingClientRect(); return { t: b.top, b: b.bottom, l: b.left, r: b.right }; };
      const tb = document.querySelector('[data-media-toolbar]');
      return { toolbar: r(tb), placement: tb.getAttribute('data-media-toolbar-placement'), box: r(document.querySelector('[data-media-kind="note"]')), page: r(document.querySelector('[data-page-index="0"]')) };
    });
  const overlaps = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;

  const mid = await rects();
  check('in the middle of a page the toolbar stands above the box', mid.placement === 'above' && mid.toolbar.b <= mid.box.t, `${Math.round(mid.toolbar.b)} vs ${Math.round(mid.box.t)}`);

  // Up to the top of the page by its grip.
  const t = await (await page.$('[data-media-kind="note"]')).boundingBox();
  await page.mouse.move(t.x + t.width / 2, t.y - 12);
  await page.mouse.down();
  await page.mouse.move(t.x + t.width / 2, 150, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const top = await rects();
  check('near the top of the page it goes underneath instead', top.placement === 'below' && top.toolbar.t >= top.box.b, `${top.placement}: ${Math.round(top.toolbar.t)} vs ${Math.round(top.box.b)}`);
  check('and so never covers the text', !overlaps(top.toolbar, top.box));
  check('nor spills off the page', top.toolbar.b <= top.page.b && top.toolbar.t >= top.page.t);

  // Pulled aside by its grip, and put back by a double-click on it.
  const grip = await (await page.$('[data-media-toolbar-grip]')).boundingBox();
  const gx = grip.x + grip.width / 2;
  const gy = grip.y + grip.height / 2;
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  await page.mouse.move(gx + 120, gy + 200, { steps: 8 });
  await page.mouse.up();
  const moved = await rects();
  check('its grip moves it', Math.abs(moved.toolbar.t - (top.toolbar.t + 200)) < 6 && Math.abs(moved.toolbar.l - (top.toolbar.l + 120)) < 6, `${Math.round(moved.toolbar.l - top.toolbar.l)}, ${Math.round(moved.toolbar.t - top.toolbar.t)}`);
  const regrip = await (await page.$('[data-media-toolbar-grip]')).boundingBox();
  await page.mouse.dblclick(regrip.x + regrip.width / 2, regrip.y + regrip.height / 2);
  const home = await rects();
  check('a double-click puts it back', Math.abs(home.toolbar.t - top.toolbar.t) < 4 && Math.abs(home.toolbar.l - top.toolbar.l) < 4);
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * The colours and the two quick widths. Black, blue, green, red, brown, purple, orange
 * and pink; a fine 1 px to write with and a broader 5 px to rule lines with, a tap
 * away, and a hold saves the slider's width into one of them.
 */
async function checkQuickSettings(browser) {
  console.log('colours and quick widths, 1280x800:');
  const errors = [];
  for (const dock of ['bottom', 'left']) {
    const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
    await ctx.addInitScript((d) => { if (!localStorage.getItem('notes.preferences.v1')) localStorage.setItem('notes.preferences.v1', JSON.stringify({ paletteDock: d })); }, dock);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await openDocument(page);
    await page.waitForSelector('[data-tool-palette]', { state: 'visible', timeout: 10_000 });
    const reading = () => page.$eval('[data-thickness-value]', (el) => el.textContent.trim());

    if (dock === 'bottom') {
      const colours = await page.$$eval('[data-swatch]', (els) => els.map((e) => e.getAttribute('data-swatch')));
      check('the colours are black, blue, green, red, brown, purple, orange, pink', colours.length === 8 && colours.join() === ['#1f1f24', '#2563eb', '#16a34a', '#dc2626', '#8b5a2b', '#7c3aed', '#ea580c', '#ec4899'].join(), colours.join(' '));
      check('the pen starts at the finest width, 1 px', (await reading()) === '1px', await reading());
    }
    const presets = await page.$$eval('[data-width-preset]', (els) => els.map((e) => e.getAttribute('data-width-value')));
    check(`${dock}: two quick widths, 1 and 5`, presets.join() === '1,5', presets.join());
    check(`${dock}: they sit inside the colour controls`, await page.$eval('[data-width-presets]', (el) => el.closest('[data-tool-config]') !== null));

    await page.click('[data-width-preset="1"]');
    check(`${dock}: the 5 sets the width to 5 px`, (await reading()) === '5px', await reading());
    check(`${dock}: and shows which is in use`, (await page.$eval('[data-width-preset="1"]', (e) => e.getAttribute('aria-pressed'))) === 'true');
    await page.click('[data-width-preset="0"]');
    check(`${dock}: the 1 sets it back`, (await reading()) === '1px', await reading());

    if (dock === 'left') {
      const inside = await page.evaluate(() => {
        const config = document.querySelector('[data-tool-config]').getBoundingClientRect();
        return [...document.querySelectorAll('[data-width-preset]')].every((el) => { const r = el.getBoundingClientRect(); return r.left >= config.left - 0.5 && r.right <= config.right + 0.5; });
      });
      check('left: the quick widths fit the slim column', inside);
    }

    // Holding one saves the slider's width into it.
    await page.$eval('[data-thickness]', (el) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, '3');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    check(`${dock}: the slider still sets any width`, (await reading()) === '3px', await reading());
    const b = await (await page.$('[data-width-preset="1"]')).boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(800);
    await page.mouse.up();
    check(`${dock}: holding a quick width saves the slider's width into it`, (await page.$eval('[data-width-preset="1"]', (e) => e.getAttribute('data-width-value'))) === '3');
    check(`${dock}: and that hold did not also pick it`, (await reading()) === '3px');

    if (dock === 'bottom') {
      // The pointer over a page is a setting: the small cross, the system's own, or the arrow.
      const cursor = () => page.$eval('[data-layer="live"]', (el) => getComputedStyle(el).cursor);
      check('the pointer starts as the small cross', (await cursor()).startsWith('url('), (await cursor()).slice(0, 40));
      await page.click('[data-palette-settings-trigger]');
      await page.waitForSelector('[data-pointer-style="crosshair"]', { state: 'visible' });
      await page.click('[data-pointer-style="crosshair"]');
      check('the system crosshair swaps it in', (await cursor()) === 'crosshair', await cursor());
      await page.click('[data-pointer-style="arrow"]');
      check('the arrow does too', (await cursor()) === 'default', await cursor());
      await page.click('[data-pointer-style="cross"]');
      check('and the small cross comes back', (await cursor()).startsWith('url('));
      await page.click('[data-pointer-style="crosshair"]');
      await page.keyboard.press('Escape');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-new-document]');
      check('the choice is still there after a reload', (await page.evaluate(() => document.documentElement.dataset.pointer)) === 'crosshair');
    }
    await ctx.close();
  }
  check('no page errors', errors.length === 0, errors.join(' | '));
}

/**
 * A long stroke is drawn a chunk at a time while the pen is down: what is behind stays
 * on the live canvas and the last stretch is redrawn on a canvas of its own above it,
 * which goes away with the stroke. Nothing may be left behind, and the ink has to land.
 */
async function checkLongStroke(browser) {
  console.log('a long stroke, 1280x800:');
  const { ctx, page, errors, cx, cy } = await openPenDocument(browser);
  const inkBox = (selector) =>
    page.$eval(selector, (canvas) => {
      const { data, width, height } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      let minX = width, minY = height, maxX = -1, maxY = -1, count = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3] > 100) { count++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      return { count, minX, minY, maxX, maxY };
    });
  // Down, then a few hundred samples round a loop, and hold there.
  await page.evaluate(([x, y]) => {
    const live = document.querySelector('[data-layer="live"]');
    const fire = (type, px, py, buttons) => live.dispatchEvent(new PointerEvent(type, { pointerType: 'pen', pointerId: 7, isPrimary: true, bubbles: true, cancelable: true, clientX: px, clientY: py, buttons, button: type === 'pointermove' ? -1 : 0, pressure: buttons & 1 ? 0.5 : 0 }));
    window.__hold = async () => {
      fire('pointerdown', x, y, 1);
      for (let i = 1; i < 500; i++) {
        const a = i * 0.05;
        fire('pointermove', x + 90 * Math.cos(a) * 1.3, y + 90 * Math.sin(a), 1);
        if (i % 4 === 0) await new Promise((r) => setTimeout(r, 6));
      }
      await new Promise((r) => setTimeout(r, 120));
    };
    window.__release = () => fire('pointerup', x, y, 0);
  }, [cx, cy]);
  await page.evaluate(() => window.__hold());
  check('while the pen is down a long stroke has a tail layer', (await page.$('[data-layer="tail"]')) !== null);
  check('which cannot take the pen\'s events', await page.$eval('[data-layer="tail"]', (el) => getComputedStyle(el).pointerEvents === 'none'));
  const tail = await inkBox('[data-layer="tail"]');
  const live = await inkBox('[data-layer="live"]');
  check('the stretch behind it is on the live canvas', live.count > 0 && tail.count > 0, `live ${live.count}px, tail ${tail.count}px`);
  check('and the tail is only the last stretch, not the whole loop', tail.count < live.count, `tail ${tail.count}px, live ${live.count}px`);

  await page.evaluate(() => window.__release());
  await page.waitForTimeout(200);
  check('when the pen lifts the tail layer goes', (await page.$('[data-layer="tail"]')) === null);
  check('the live canvas is left empty', (await inkBox('[data-layer="live"]')).count === 0);
  const committed = await inkBox('[data-layer="committed"]');
  check('and the whole stroke is on the page', committed.count > 0 && committed.maxX - committed.minX > 150, `${committed.count}px, ${committed.maxX - committed.minX} wide`);
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * Flipping, grouping, lining up, copying and pasting a selection, driven the way a
 * person does it: with the lasso, the selection's toolbar and the keyboard.
 */
async function checkArrange(browser) {
  console.log('flip, group, align, copy and paste, 1280x800:');
  const { ctx, page, errors, cx, cy } = await openPenDocument(browser);
  const box = () => page.$eval('[data-selection-box]', (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  const hasBox = () => page.$('[data-selection-box]').then((x) => x !== null);
  const ink = () =>
    page.$eval('[data-layer="committed"]', (canvas) => {
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      let n = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 100) n++;
      return n;
    });
  const inkAt = (x, y, r = 6) =>
    page.$eval('[data-layer="committed"]', (canvas, [px, py, rad]) => {
      const rect = canvas.getBoundingClientRect();
      const s = canvas.width / rect.width;
      const { data } = canvas.getContext('2d').getImageData(Math.round((px - rect.left - rad) * s), Math.round((py - rect.top - rad) * s), Math.round(2 * rad * s), Math.round(2 * rad * s));
      let n = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 100) n++;
      return n;
    }, [x, y, r]);
  const ring = (x, y, rx, ry) =>
    Array.from({ length: 31 }, (_, i) => [x + rx * Math.cos((i * 12 * Math.PI) / 180), y + ry * Math.sin((i * 12 * Math.PI) / 180)]);
  const lasso = async (x, y, rx, ry) => {
    await page.click('[data-palette-tool="lasso"]');
    await page.evaluate(([pts]) => window.__pen.stroke(pts, 1), [ring(x, y, rx, ry)]);
    await page.waitForSelector('[data-selection-box]', { timeout: 3_000 });
  };
  const bar = (x, y, w) => Array.from({ length: 12 }, (_, i) => [x + (i * w) / 11, y]);
  const draw = async (pts) => page.evaluate(([p]) => window.__pen.stroke(p, 1), [pts]);

  // Flip: a slanted line, top-left to bottom-right, stands top-right to bottom-left afterwards.
  const top = cy - 150;
  await draw(Array.from({ length: 30 }, (_, i) => [cx - 200 + i * 4, top + i * 4]));
  await lasso(cx - 142, top + 58, 100, 90);
  const slantBefore = { tl: await inkAt(cx - 198, top + 2), tr: await inkAt(cx - 200 + 29 * 4 - 2, top + 2) };
  check('before: the line starts top-left', slantBefore.tl > 0 && slantBefore.tr === 0, JSON.stringify(slantBefore));
  check('a selection offers both flips', (await page.$('[data-selection-flip="horizontal"]')) !== null && (await page.$('[data-selection-flip="vertical"]')) !== null);
  await page.click('[data-selection-flip="horizontal"]');
  await page.waitForTimeout(150);
  const slantAfter = { tl: await inkAt(cx - 198, top + 2), tr: await inkAt(cx - 200 + 29 * 4 - 2, top + 2) };
  check('flipped left to right, it starts top-right', slantAfter.tr > 0 && slantAfter.tl === 0, JSON.stringify(slantAfter));
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  check('undo flips it back', (await inkAt(cx - 198, top + 2)) > 0);
  await page.keyboard.press('Escape');

  // Three bars of different lengths, left edges scattered.
  const y0 = cy + 30;
  await page.click('[data-palette-tool="pen"]');
  await draw(bar(cx - 180, y0, 60));
  await draw(bar(cx - 120, y0 + 50, 140));
  await draw(bar(cx + 10, y0 + 100, 90));
  await lasso(cx - 40, y0 + 50, 170, 90);
  const spread = await box();
  check('three bars are offered Align', (await page.$('[data-selection-align-toggle]')) !== null);
  check('the align row starts closed', (await page.$('[data-selection-align-row]')) === null);
  await page.click('[data-selection-align-toggle]');
  await page.waitForSelector('[data-selection-align-row]');
  check('with three there is spreading too', (await page.$('[data-selection-distribute="horizontal"]')) !== null);
  await page.click('[data-selection-align="left"]');
  await page.waitForTimeout(150);
  const flush = await box();
  check('aligning left edges brings the bars together', flush.w < spread.w - 60, `${Math.round(spread.w)} -> ${Math.round(flush.w)}`);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  check('undo puts them back', (await box()).w > spread.w - 4);

  // Group two of them: a lasso round one takes both.
  await page.keyboard.press('Escape');
  await page.click('[data-palette-tool="lasso"]');
  await page.evaluate(([pts]) => window.__pen.stroke(pts, 1), [ring(cx - 150, y0, 50, 14)]);
  await page.waitForSelector('[data-selection-box]', { timeout: 3_000 });
  const justOne = await box();
  check('before grouping, a loop round one bar takes one', justOne.w < 130, `${Math.round(justOne.w)}px wide`);
  check('one stroke on its own cannot be grouped', (await page.$('[data-selection-group]')) === null && (await page.$('[data-selection-ungroup]')) === null);
  await page.keyboard.press('Escape');
  await lasso(cx - 80, y0 + 25, 130, 55);
  await page.click('[data-selection-group]');
  check('a group offers Ungroup and no longer Group', (await page.$('[data-selection-ungroup]')) !== null && (await page.$('[data-selection-group]')) === null);
  await page.keyboard.press('Escape');
  await page.click('[data-palette-tool="lasso"]');
  await page.evaluate(([pts]) => window.__pen.stroke(pts, 1), [ring(cx - 150, y0, 50, 14)]);
  await page.waitForSelector('[data-selection-box]', { timeout: 3_000 });
  const whole = await box();
  check('after grouping, a loop round one bar takes the whole group', whole.w > justOne.w + 60 && whole.h > justOne.h + 30, `${Math.round(justOne.w)}x${Math.round(justOne.h)} -> ${Math.round(whole.w)}x${Math.round(whole.h)}`);
  await page.click('[data-selection-ungroup]');
  await page.keyboard.press('Escape');

  // Copy and paste, by button and by key.
  await lasso(cx - 40, y0 + 50, 170, 90);
  const before = await ink();
  await page.click('[data-selection-copy]');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-paste-pill]', { timeout: 3_000 });
  check('with something copied, the page offers to paste it', true);
  await page.click('[data-paste-pill]');
  await page.waitForTimeout(200);
  const afterPaste = await ink();
  check('pasting adds the copies to the page', afterPaste > before * 1.6, `${before} -> ${afterPaste}px of ink`);
  check('and selects them', await hasBox());
  check('the paste offer goes away once there is a selection', (await page.$('[data-paste-pill]')) === null);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);
  check('undo takes the paste back off in one step', (await ink()) <= before + 4, `${await ink()} vs ${before}`);
  await page.keyboard.press('Escape');
  await page.click('[data-palette-tool="pen"]');
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(250);
  check('Ctrl+V pastes from the keyboard, and brings the lasso out to show the copies', (await hasBox()) && (await ink()) > before * 1.6);
  await page.click('[data-selection-cut]');
  await page.waitForTimeout(200);
  check('cut takes the selection off the page', !(await hasBox()) && (await ink()) <= before + 4, `${await ink()} vs ${before}`);

  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * The shape tool's grid switch: both ends of a line land on the page's grid, not
 * where the pen was.
 */
async function checkGridSnap(browser) {
  console.log('snap to grid, 1280x800:');
  const { ctx, page, errors } = await openPenDocument(browser);
  await page.click('[data-palette-tool="line"]');
  await page.click('[data-palette-tool="line"]');
  await page.waitForSelector('[data-line-grid-snap]', { state: 'visible', timeout: 3_000 });
  await page.click('[data-line-grid-snap]');
  await page.keyboard.press('Escape');
  const spacing = await page.$eval('[data-layer="surface"]', (el) => Number(el.getAttribute('data-grid-spacing')));
  check('the page tells the tool its grid', spacing >= 2, `${spacing}`);
  const origin = await page.$eval('[data-layer="live"]', (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, scale: el.width / r.width }; });
  const at = (x, y) => [origin.x + x, origin.y + y];
  const snap = (v) => Math.round(v / spacing) * spacing;
  const ex = 4.5 * spacing + 6;
  const ey = 3 * spacing + 17;
  await page.evaluate(([pts]) => window.__pen.stroke(pts, 1), [[at(spacing + 7, spacing + 9), at(3 * spacing, 2 * spacing), at(ex, ey)]]);
  await page.waitForTimeout(200);
  const inkNear = (x, y, r = 3) =>
    page.$eval('[data-layer="committed"]', (canvas, [px, py, rad, scale]) => {
      const { data } = canvas.getContext('2d').getImageData(Math.round((px - rad) * scale), Math.round((py - rad) * scale), Math.round(2 * rad * scale), Math.round(2 * rad * scale));
      let n = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 100) n++;
      return n;
    }, [x, y, r, origin.scale]);
  const endX = snap(ex);
  const endY = snap(ey);
  check('the far end lands on the grid point nearest the pen', (await inkNear(endX, endY)) > 0, `grid ${spacing}: ${endX},${endY}`);
  check('and the line goes no further than it', (await inkNear(endX + 12, endY + 9)) === 0);
  check('the near end is on the grid too', (await inkNear(snap(spacing + 7), snap(spacing + 9))) > 0);
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * The ruler and the protractor: brought out from the Add menu, moved, turned and put
 * away by their controls, and a pen drawn along the ruler comes out straight.
 */
async function checkAids(browser) {
  console.log('ruler and protractor, 1280x800:');
  const { ctx, page, errors } = await openPenDocument(browser);
  const rulerRect = () => page.$eval('[data-ruler]', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, angle: Number(el.getAttribute('data-ruler-angle')) }; });
  const openFromMenu = async (selector) => {
    await page.click('[data-insert-trigger]');
    await page.waitForSelector(selector, { state: 'visible', timeout: 3_000 });
    await page.click(selector);
  };
  const inkBox = (selector = '[data-layer="committed"]') =>
    page.$eval(selector, (canvas) => {
      const rect = canvas.getBoundingClientRect();
      const s = canvas.width / rect.width;
      const { data, width, height } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      let minX = width, minY = height, maxX = -1, maxY = -1, count = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3] > 100) { count++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      return { count, x0: rect.left + minX / s, x1: rect.left + maxX / s, y0: rect.top + minY / s, y1: rect.top + maxY / s };
    });

  check('there is no ruler until one is asked for', (await page.$('[data-ruler]')) === null);
  await openFromMenu('[data-insert-ruler]');
  await page.waitForSelector('[data-ruler]', { timeout: 3_000 });
  const flat = await rulerRect();
  check('the ruler comes out level, across the upper part of the page', flat.angle === 0 && flat.w > 300 && flat.h > 40);

  // A wandering hand along the ruler's upper edge comes out straight.
  const y = flat.y - 8;
  const wobble = Array.from({ length: 40 }, (_, i) => [flat.x + 60 + i * 8, y + Math.sin(i / 2) * 6]);
  await page.evaluate(([pts]) => window.__pen.stroke(pts, 1), [wobble]);
  await page.waitForTimeout(150);
  const ruled = await inkBox();
  check('it follows the edge, however the hand wandered', ruled.y1 - ruled.y0 <= 3, `${(ruled.y1 - ruled.y0).toFixed(1)}px tall`);
  check('and sits on the edge, not where the pen was', Math.abs(ruled.y0 - flat.y) <= 3, `${ruled.y0.toFixed(1)} vs ${flat.y.toFixed(1)}`);
  check('as far as the pen went', Math.abs(ruled.x1 - ruled.x0 - 39 * 8) <= 6, `${(ruled.x1 - ruled.x0).toFixed(1)} of ${39 * 8}`);

  // One started away from the ruler is an ordinary stroke.
  await page.evaluate(([pts]) => window.__pen.stroke(pts, 1), [Array.from({ length: 30 }, (_, i) => [flat.x + 60 + i * 8, flat.y - 140 + Math.sin(i / 2) * 12])]);
  await page.waitForTimeout(150);
  const free = await inkBox();
  check('a stroke that starts away from the ruler stays a stroke', free.y0 < ruled.y0 - 100 + 30, `${free.y0.toFixed(1)}`);

  // Along the ruler, not past its end.
  const before = await inkBox();
  await page.evaluate(([pts]) => window.__pen.stroke(pts, 1), [[[flat.x + flat.w - 40, flat.y + flat.h + 6], [flat.x + flat.w + 120, flat.y + flat.h + 6]]]);
  await page.waitForTimeout(150);
  const after = await inkBox();
  check('a line stops where the ruler does', after.x1 <= flat.x + flat.w + 3 && after.x1 >= before.x1 - 1, `${after.x1.toFixed(1)} vs ${(flat.x + flat.w).toFixed(1)}`);

  // Move, turn, put away.
  const grip = await (await page.$('[data-ruler-move]')).boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + 120, { steps: 8 });
  await page.mouse.up();
  const moved = await rulerRect();
  check('its grip moves it', Math.abs(moved.y - flat.y - 120) < 3 && Math.abs(moved.x - flat.x) < 3, `${(moved.y - flat.y).toFixed(1)}`);

  const turn = await (await page.$('[data-ruler-turn]')).boundingBox();
  const centre = { x: moved.x + moved.w / 2, y: moved.y + moved.h / 2 };
  await page.mouse.move(turn.x + turn.width / 2, turn.y + turn.height / 2);
  await page.mouse.down();
  await page.mouse.move(centre.x, centre.y + 200, { steps: 10 });
  await page.mouse.up();
  const turned = await rulerRect();
  check('its other end turns it, to a quarter turn when taken straight down', turned.angle === 90, `${turned.angle}°`);
  check('and it stands up', turned.h > turned.w);

  await page.click('[data-ruler-close]');
  check('its cross puts it away', (await page.$('[data-ruler]')) === null);
  await openFromMenu('[data-insert-ruler]');
  await page.waitForSelector('[data-ruler]');
  await openFromMenu('[data-insert-ruler]');
  check('the menu puts it away too', (await page.$('[data-ruler]')) === null);

  // The protractor.
  await openFromMenu('[data-insert-protractor]');
  await page.waitForSelector('[data-protractor]', { timeout: 3_000 });
  const pr = () => page.$eval('[data-protractor]', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const p0 = await pr();
  check('the protractor comes out as a half disc, wider than tall', p0.w > p0.h * 1.5, `${Math.round(p0.w)}x${Math.round(p0.h)}`);
  const pg = await (await page.$('[data-protractor-move]')).boundingBox();
  await page.mouse.move(pg.x + pg.width / 2, pg.y + pg.height / 2);
  await page.mouse.down();
  await page.mouse.move(pg.x + pg.width / 2 + 40, pg.y + pg.height / 2 - 60, { steps: 6 });
  await page.mouse.up();
  const p1 = await pr();
  check('it moves by its grip', Math.abs(p1.x - p0.x - 40) < 3 && Math.abs(p1.y - p0.y + 60) < 3, JSON.stringify({ p0, p1 }));
  const pt = await (await page.$('[data-protractor-turn]')).boundingBox();
  const vertex = { x: p1.x + p1.w / 2, y: p1.y + (p1.w / 2) };
  await page.mouse.move(pt.x + pt.width / 2, pt.y + pt.height / 2);
  await page.mouse.down();
  await page.mouse.move(vertex.x + 200, vertex.y, { steps: 10 });
  await page.mouse.up();
  const p2 = await pr();
  check('it turns by its handle, to stand on its side', p2.h > p2.w * 0.9 || p2.w < p1.w - 50, `${Math.round(p2.w)}x${Math.round(p2.h)}`);
  await page.click('[data-protractor-close]');
  check('and is put away by its cross', (await page.$('[data-protractor]')) === null);

  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * The zoom window: a magnified strip to write in, whose strokes land on the page at the
 * page's own size, that moves along by itself as the writing reaches its end.
 */
async function checkZoomWindow(browser) {
  console.log('zoom window, 1280x800:');
  const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openDocument(page);
  await page.waitForSelector('[data-insert-trigger]', { timeout: 10_000 });
  const rect = (selector) => page.$eval(selector, (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const inkBox = (selector) =>
    page.$eval(selector, (canvas) => {
      const rect = canvas.getBoundingClientRect();
      const s = canvas.width / rect.width;
      const { data, width, height } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      let minX = width, minY = height, maxX = -1, maxY = -1, count = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3] > 100) { count++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      return { count, x0: rect.left + minX / s, x1: rect.left + maxX / s, y0: rect.top + minY / s, y1: rect.top + maxY / s };
    });

  check('there is no zoom window until one is asked for', (await page.$('[data-zoom-window]')) === null);
  const before = await rect('[data-viewer]');
  await page.click('[data-insert-trigger]');
  await page.click('[data-insert-zoom-window]');
  await page.waitForSelector('[data-zoom-window]', { timeout: 5_000 });
  await page.waitForSelector('[data-zoom-area] [data-layer="live"]', { state: 'attached' });
  await page.waitForTimeout(300);
  const after = await rect('[data-viewer]');
  check('it takes its room from below the page, which gets shorter', after.h < before.h - 150, `${Math.round(before.h)} -> ${Math.round(after.h)}`);
  check('the page shows where it is looking', (await page.$('[data-zoom-region]')) !== null);

  const area = await rect('[data-zoom-area]');
  const region = await rect('[data-zoom-region]');
  check('at 3x the region is a third of the window across', Math.abs(region.w - area.w / 3) < 4, `${Math.round(region.w)} vs ${Math.round(area.w / 3)}`);

  // A line written in the window lands on the page a third as long, where the region is.
  const x0 = area.x + 60;
  const y0 = area.y + area.h / 2;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x0 + 150, y0 + 30, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const onPage = await inkBox('[data-page-index="0"] [data-layer="committed"]');
  const expectedX = region.x + (x0 - area.x) / 3;
  const expectedY = region.y + (y0 - area.y) / 3;
  check('the stroke is on the page', onPage.count > 0);
  check('where the region is, a third of the distance in from its corner', Math.abs(onPage.x0 - expectedX) < 4 && Math.abs(onPage.y0 - expectedY) < 4, `${onPage.x0.toFixed(1)},${onPage.y0.toFixed(1)} vs ${expectedX.toFixed(1)},${expectedY.toFixed(1)}`);
  check('and a third as long as it was written', Math.abs(onPage.x1 - onPage.x0 - 50) < 5, `${(onPage.x1 - onPage.x0).toFixed(1)} vs 50`);
  const inWindow = await inkBox('[data-zoom-area] [data-layer="committed"]');
  check('the window shows it at the size it was written', Math.abs(inWindow.x1 - inWindow.x0 - 150) < 6, `${(inWindow.x1 - inWindow.x0).toFixed(1)} vs 150`);

  // Writing that reaches the end of the strip moves it on.
  const regionBefore = await rect('[data-zoom-region]');
  const ex = area.x + area.w - 70;
  await page.mouse.move(ex - 40, y0);
  await page.mouse.down();
  await page.mouse.move(ex, y0, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(450);
  const regionAfter = await rect('[data-zoom-region]');
  check('the window moves along by itself', regionAfter.x > regionBefore.x + 40, `${Math.round(regionBefore.x)} -> ${Math.round(regionAfter.x)}`);

  // Next line: back to where the line began, and down.
  await page.click('[data-zoom-next-line]');
  const next = await rect('[data-zoom-region]');
  check('next line goes back to where the line began', Math.abs(next.x - region.x) < 4, `${Math.round(next.x)} vs ${Math.round(region.x)}`);
  check('and down', next.y > regionAfter.y + 20, `${Math.round(regionAfter.y)} -> ${Math.round(next.y)}`);

  // Magnification.
  await page.click('[data-zoom-mag="4"]');
  await page.waitForTimeout(150);
  const four = await rect('[data-zoom-region]');
  check('at 4x the region is smaller still', four.w < next.w - 40 && (await page.$eval('[data-zoom-window]', (el) => el.getAttribute('data-zoom-magnification'))) === '4', `${Math.round(next.w)} -> ${Math.round(four.w)}`);

  // The marker on the page moves the window's view.
  const grip = await (await page.$('[data-zoom-region-move]')).boundingBox();
  const beforeDrag = await rect('[data-zoom-region]');
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 60, grip.y + grip.height / 2 + 80, { steps: 6 });
  await page.mouse.up();
  const dragged = await rect('[data-zoom-region]');
  check('dragging the marker moves where the window is looking', Math.abs(dragged.x - beforeDrag.x - 60) < 4 && Math.abs(dragged.y - beforeDrag.y - 80) < 4, `${Math.round(dragged.x - beforeDrag.x)}, ${Math.round(dragged.y - beforeDrag.y)}`);

  await page.click('[data-zoom-close]');
  await page.waitForTimeout(200);
  check('closing it gives the page its room back', (await page.$('[data-zoom-window]')) === null && (await page.$('[data-zoom-region]')) === null);
  check('and leaves what was written on the page', (await inkBox('[data-page-index="0"] [data-layer="committed"]')).count > 0);

  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * Search inside a note: a text box, a sticky note and a table cell each holding the word,
 * found from one box, each result going to its object, Esc putting it away.
 */
async function checkSearch(browser) {
  console.log('searching a note, 1280x800:');
  const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openDocument(page);
  await page.waitForSelector('[data-insert-trigger]', { timeout: 10_000 });

  check('there is no search panel until one is asked for', (await page.$('[data-search-panel]')) === null);

  await page.click('[data-insert-trigger]');
  await page.click('[data-insert-text]');
  await page.waitForSelector('[data-text-content]');
  await page.type('[data-text-content]', 'Buy a Lemon today');
  await page.click('[data-insert-trigger]');
  await page.click('[data-insert-note]');
  await page.waitForSelector('[data-note-text]');
  await page.fill('[data-note-text]', 'Lemon tree notes');
  await page.click('[data-insert-trigger]');
  await page.click('[data-insert-table]');
  await page.waitForSelector('[data-cell="0-0"]');
  await page.fill('[data-cell="0-0"]', 'lemon');

  await page.click('[data-search-toggle]');
  await page.waitForSelector('[data-search-panel]', { timeout: 5_000 });
  check('the search button opens the panel', true);
  check('with the cursor already in its box', await page.$eval('[data-search-input]', (el) => document.activeElement === el));

  await page.type('[data-search-input]', 'LEMON');
  await page.waitForSelector('[data-search-hit]', { timeout: 5_000 });
  const kinds = await page.$$eval('[data-search-hit]', (els) => els.map((el) => el.getAttribute('data-search-hit-kind')).sort());
  check('the word is found in the text box, the note and the table, whatever its case', kinds.join() === 'note,table,text', kinds.join());
  check('and the panel counts them', (await page.$eval('[data-search-count]', (el) => el.textContent)).includes('of 3'));

  await page.fill('[data-search-input]', 'limón zzz');
  await page.waitForTimeout(100);
  check('a word that is not there finds nothing', (await page.$$('[data-search-hit]')).length === 0 && (await page.$eval('[data-search-count]', (el) => el.textContent)) === 'No matches');

  await page.fill('[data-search-input]', 'lemon');
  await page.waitForSelector('[data-search-hit]');
  // Each result brings its own object under the selection: a text box's tools are the format bar, the note has
  // a shape picker in its toolbar.
  const noteTools = "[data-media-toolbar] [data-note-shape-option]";
  await page.click('[data-search-hit][data-search-hit-kind="text"]');
  await page.waitForSelector('[data-format-bar]', { timeout: 3_000 });
  check('choosing the text box result selects the text box', (await page.$(noteTools)) === null);
  await page.click('[data-search-hit][data-search-hit-kind="note"]');
  await page.waitForSelector(noteTools, { timeout: 3_000 });
  check('and choosing the note result selects the note', true);

  await page.focus('[data-search-input]');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  check('Escape puts the panel away', (await page.$('[data-search-panel]')) === null);

  await page.mouse.click(40, 400);
  await page.keyboard.press('Control+f');
  await page.waitForSelector('[data-search-panel]', { timeout: 3_000 });
  check('Ctrl+F brings it back', true);
  check('with what was searched for still in the box', (await page.$eval('[data-search-input]', (el) => el.value)) === 'lemon');

  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * Searching the whole library from its home screen. The browser library has no autosave of its own,
 * so the note is written into it by hand: two pages, a text box and a sticky note on the first and a
 * table on the second.
 */
async function checkLibrarySearch(browser) {
  console.log('searching the library, 1280x800:');
  const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openDocument(page);
  await page.click('[data-back-to-library]');
  await page.waitForSelector('[data-library-view]', { timeout: 10_000 });

  const seeded = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('notes.library.doc.'));
    if (!key) return false;
    const envelope = JSON.parse(localStorage.getItem(key));
    const doc = envelope.document;
    doc.title = 'Kitchen plans';
    const box = { x: 100, y: 100, width: 300, height: 80, rotation: 0, zIndex: 1 };
    const first = { ...doc.pages[0], media: [
      { ...box, id: 'mt', kind: 'text', text: 'Zebra crossing ahead', fontFamily: 'sans', fontSize: 16, color: '#000', bold: false, italic: false, underline: false, strikethrough: false, align: 'left' },
      { ...box, id: 'mn', kind: 'note', text: 'remember the zebra', color: '#fef08a' },
    ] };
    const second = { ...first, id: 'second-page', pageNumber: 2, media: [
      { ...box, id: 'mb', kind: 'table', rows: 1, columns: 2, cells: ['quartz', 'granite'] },
    ] };
    doc.pages = [first, second];
    localStorage.setItem(key, JSON.stringify(envelope));
    return true;
  });
  check('a note with words in it is in the library', seeded);

  check('there are no search results until something is typed', (await page.$('[data-library-search-results]')) === null);
  await page.fill('[data-library-search]', 'ZEBRA');
  await page.waitForSelector('[data-library-search-note]', { timeout: 5_000 });
  const pagesOfHits = await page.$$eval('[data-library-search-hit]', (els) => els.map((e) => e.getAttribute('data-library-search-hit-page')));
  check('the note is found by the words inside it, whatever their case', (await page.$$('[data-library-search-note]')).length === 1 && pagesOfHits.join() === '0,0', pagesOfHits.join());
  check('the note cards give way to the results', (await page.$('[data-library-entries]')) === null);

  await page.fill('[data-library-search]', 'kitchen');
  await page.waitForTimeout(150);
  check('it is found by its title too', (await page.$$('[data-library-search-note]')).length === 1);

  await page.fill('[data-library-search]', 'nothing like this');
  await page.waitForTimeout(150);
  check('and a word that is in no note finds none', (await page.$$('[data-library-search-note]')).length === 0 && (await page.$eval('[data-library-search-status]', (e) => e.textContent)).startsWith('No notes'));

  await page.fill('[data-library-search]', 'quartz');
  await page.waitForSelector('[data-library-search-hit]', { timeout: 5_000 });
  check('a match on the second page says so', (await page.$eval('[data-library-search-hit]', (e) => e.getAttribute('data-library-search-hit-page'))) === '1');
  await page.click('[data-library-search-hit]');
  await page.waitForSelector('[data-arranger-toggle]', { timeout: 10_000 });
  await page.waitForSelector('[data-media-toolbar]', { timeout: 5_000 }).catch(() => {});
  check('choosing it opens the note at that page', (await page.$eval('[data-page-badge]', (e) => e.textContent)).includes('Page 2'), await page.$eval('[data-page-badge]', (e) => e.textContent));
  check('with the table that holds the word selected', (await page.$('[data-media-toolbar]')) !== null);

  await page.click('[data-back-to-library]');
  await page.waitForSelector('[data-library-view]', { timeout: 10_000 });
  check('back in the library the box is empty and the notes are shown again', (await page.$eval('[data-library-search]', (e) => e.value)) === '' && (await page.$('[data-library-entries]')) !== null);

  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * The library search finds words that are only in a note's PDF: the note's own text first, then its PDFs read (once,
 * and kept), each hit pointing at the note's page made from that page of the PDF.
 */
async function checkLibraryPdfSearch(browser) {
  console.log('searching the PDFs in the library, 1280x800:');
  const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openDocument(page);
  await page.click('[data-back-to-library]');
  await page.waitForSelector('[data-library-view]', { timeout: 10_000 });

  const pdf = Buffer.from(tinyPdf(2, 'Linear algebra', { lines: (i) => (i === 0 ? ['Eigenvalues of a matrix'] : ['Determinants and traces']) })).toString('base64');
  const seeded = await page.evaluate((data) => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('notes.library.doc.'));
    if (!key) return false;
    const envelope = JSON.parse(localStorage.getItem(key));
    const doc = envelope.document;
    doc.title = 'Week 4';
    const base = doc.pages[0];
    const box = { x: 100, y: 100, width: 300, height: 80, rotation: 0, zIndex: 1 };
    const typed = { ...base, media: [{ ...box, id: 'mt', kind: 'text', text: 'my summary', fontFamily: 'sans', fontSize: 16, color: '#000', bold: false, italic: false, underline: false, strikethrough: false, align: 'left' }] };
    const fromPdf = (id, pageIndex) => ({
      ...base,
      id,
      template: 'pdf',
      dimensions: { width: 816, height: 1056 },
      media: [],
      pdf: { sourceId: 'pdf_la', pageIndex, viewBox: [0, 0, 612, 792], rotation: 0, scale: 4 / 3 },
    });
    doc.pages = [typed, fromPdf('pa', 0), fromPdf('pb', 1)];
    doc.pdfSources = { pdf_la: { name: 'Linear algebra.pdf', pageCount: 2, data } };
    localStorage.setItem(key, JSON.stringify(envelope));
    return true;
  }, pdf);
  check('a note made from a PDF is in the library', seeded);

  await page.fill('[data-library-search]', 'determinants');
  await page.waitForSelector('[data-library-search-hit]', { timeout: 20_000 });
  const hit = await page.$eval('[data-library-search-hit]', (e) => ({ page: e.getAttribute('data-library-search-hit-page'), text: e.textContent }));
  check('a word only the PDF has finds the note', hit.text.includes('Determinants'), hit.text);
  check('on the note\'s page made from that page of the PDF, marked as from the PDF', hit.page === '2' && hit.text.includes('PDF'), JSON.stringify(hit));
  await page.waitForFunction(() => !/Reading/.test(document.querySelector('[data-library-search-status]')?.textContent ?? ''), null, { timeout: 10_000 });

  await page.fill('[data-library-search]', 'summary');
  await page.waitForSelector('[data-library-search-hit]', { timeout: 5_000 });
  check('the note\'s own words are still found', (await page.$eval('[data-library-search-hit]', (e) => e.textContent)).includes('Text box'));

  const kept = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('kk-notes-search');
        open.onsuccess = () => {
          const req = open.result.transaction('pdf-text', 'readonly').objectStore('pdf-text').get('pdf_la');
          req.onsuccess = () => resolve(req.result ?? null);
          req.onerror = () => resolve(null);
        };
        open.onerror = () => resolve(null);
      }),
  );
  check('the PDF\'s words are kept, so it is read only once', Array.isArray(kept) && kept.length === 2 && kept[0].includes('Eigenvalues'), JSON.stringify(kept));

  await page.fill('[data-library-search]', 'eigenvalues');
  await page.waitForSelector('[data-library-search-hit]', { timeout: 5_000 });
  await page.click('[data-library-search-hit]');
  await page.waitForSelector('[data-arranger-toggle]', { timeout: 10_000 });
  await page.waitForTimeout(300);
  check('choosing it opens the note at that page', (await page.$eval('[data-page-badge]', (e) => e.textContent)).includes('Page 2'), await page.$eval('[data-page-badge]', (e) => e.textContent));

  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * The library search finds handwriting a recogniser read and the note saved: the hit says Handwriting, and opening it
 * goes to the page and marks the word, found again on the page from what was searched for.
 */
async function checkLibraryHandwritingSearch(browser) {
  console.log('searching handwriting in the library, 1280x800:');
  const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openDocument(page);
  await page.click('[data-back-to-library]');
  await page.waitForSelector('[data-library-view]', { timeout: 10_000 });
  const seeded = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('notes.library.doc.'));
    if (!key) return false;
    const envelope = JSON.parse(localStorage.getItem(key));
    const doc = envelope.document;
    doc.title = 'Lecture 7';
    const second = { ...doc.pages[0], id: 'second', inkText: { key: '', by: 'default', words: [
      { text: 'Laplace', x: 120, y: 600, width: 90, height: 30 },
      { text: 'transform', x: 220, y: 602, width: 110, height: 30 },
    ] } };
    doc.pages = [doc.pages[0], second];
    localStorage.setItem(key, JSON.stringify(envelope));
    return true;
  });
  check('a note with read handwriting is in the library', seeded);
  await page.fill('[data-library-search]', 'laplace transform');
  await page.waitForSelector('[data-library-search-hit]', { timeout: 10_000 });
  const hit = await page.$eval('[data-library-search-hit]', (e) => ({ page: e.getAttribute('data-library-search-hit-page'), text: e.textContent }));
  check('the library search finds the handwriting, a phrase along a line too', hit.page === '1' && hit.text.includes('Handwriting') && hit.text.includes('Laplace'), JSON.stringify(hit));
  await page.click('[data-library-search-hit]');
  await page.waitForSelector('[data-search-flash]', { timeout: 10_000 });
  check('opening it goes to the page and marks the word', (await page.$eval('[data-page-badge]', (e) => e.textContent)).includes('Page 2'));
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * The version history dialog. It needs the desktop shell, which a browser does not have, so a
 * minimal stand-in for Tauri's `invoke` answers the few commands the library and the dialog make.
 */
async function checkVersionHistory(browser) {
  console.log('version history, 1280x800 (desktop shell faked):');
  // The contents of a real, empty note, taken from a plain page of the same app.
  const seedCtx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  const seedPage = await seedCtx.newPage();
  await openDocument(seedPage);
  const contents = await seedPage.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('notes.library.doc.'));
    return localStorage.getItem(key);
  });
  await seedCtx.close();
  const restored = contents.replace(/"title":"[^"]*"/, '"title":"Back from the past"');

  const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  await ctx.addInitScript(({ contents, restored }) => {
    const PATH = '/lib/Untitled note.notex';
    window.__calls = [];
    window.__versions = [
      { id: Date.now() - 2 * 3600_000, bytes: 20480, title: 'Untitled note', pageCount: 2 },
      { id: Date.now() - 30 * 3600_000, bytes: 5_300_000, title: 'Older draft', pageCount: 1 },
    ];
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (cmd, args) => {
        window.__calls.push({ cmd, args });
        switch (cmd) {
          case 'list_library': return { path: '/lib', relativePath: '', parentPath: null, entries: [] };
          case 'create_library_document': return PATH;
          case 'open_document': return { path: PATH, contents, info: { path: PATH, bytes: contents.length, modifiedMs: 1 } };
          case 'list_versions': return window.__versions;
          case 'restore_version': return { path: PATH, contents: restored, info: { path: PATH, bytes: restored.length, modifiedMs: 2 } };
          case 'sync_status':
          case 'sync_now': return { phase: 'offline', provider: 'Not connected', pending: 0, conflicts: [], lastSyncedMs: 0, message: null };
          case 'list_recent': return [];
          default: return null;
        }
      },
    };
  }, { contents, restored });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openDocument(page);

  await page.click('[data-file-menu]');
  check('the File menu offers the history once the note is a file', await page.$eval('[data-version-history]', (el) => !el.disabled));
  await page.click('[data-version-history]');
  await page.waitForSelector('[data-versions-dialog]', { timeout: 5_000 });
  await page.waitForSelector('[data-version]', { timeout: 5_000 });
  check('the dialog lists what is kept, newest first', (await page.$$eval('[data-version]', (els) => els.map((e) => Number(e.getAttribute('data-version')))).then((ids) => ids.length === 2 && ids[0] > ids[1])));
  const text = await page.$eval('[data-versions-dialog]', (el) => el.textContent ?? '');
  check('each says when, how old, its pages and its size', text.includes('2 hours ago') && text.includes('2 pages') && text.includes('20 KB') && text.includes('5.1 MB') && text.includes('Older draft'), text.slice(0, 200));

  await page.click('[data-version-restore]');
  check('restoring asks first, and says nothing is lost', (await page.$('[data-version-confirm]')) !== null && (await page.$eval('[data-versions-note]', (el) => el.textContent ?? '')).includes('stays in the list'));
  check('nothing has been restored yet', !(await page.evaluate(() => window.__calls.some((c) => c.cmd === 'restore_version'))));
  await page.click('[data-version-confirm]');
  await page.waitForSelector('[data-versions-dialog]', { state: 'detached', timeout: 5_000 });
  const call = await page.evaluate(() => window.__calls.find((c) => c.cmd === 'restore_version'));
  check('it asks the shell to put that version back, for this note', call?.args?.path === '/lib/Untitled note.notex' && typeof call?.args?.id === 'number');
  await page.waitForFunction(() => document.querySelector('[data-title]')?.value === 'Back from the past' || document.querySelector('[data-title]')?.textContent === 'Back from the past', null, { timeout: 5_000 }).catch(() => {});
  const title = await page.$eval('[data-title]', (el) => el.value ?? el.textContent);
  check('and the note on screen becomes that version', title === 'Back from the past', title);
  check('with a notice saying so', (await page.$eval('[data-notice], [data-notice-toast]', (el) => el.textContent ?? '').catch(() => '')).includes('Restored the version from'));
  check('the note is not left marked as changed', (await page.$('[data-dirty]')) === null);

  // With nothing kept yet.
  await page.evaluate(() => { window.__versions = []; });
  await page.click('[data-file-menu]');
  await page.click('[data-version-history]');
  await page.waitForSelector('[data-versions-empty]', { timeout: 5_000 });
  check('with nothing kept it says how versions come about', (await page.$eval('[data-versions-empty]', (el) => el.textContent ?? '')).includes('each time you save'));
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-versions-dialog]', { state: 'detached', timeout: 3_000 });
  check('Esc closes it', true);

  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * The app passcode: turning it on, the lock screen at start-up, wrong and right tries, locking
 * at once, the keyboard not reaching a locked app, locking itself after a time away, and turning it off.
 */
async function checkAppLock(browser) {
  console.log('app passcode, 1280x800:');
  const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.clock.install();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-security-settings]', { timeout: 20_000 });

  check('with no passcode set there is no lock screen', (await page.$('[data-lock-screen]')) === null);
  await page.click('[data-security-settings]');
  await page.waitForSelector('[data-security-panel]');
  await page.fill('[data-lock-new]', '12');
  await page.fill('[data-lock-repeat]', '12');
  await page.click('[data-lock-save]');
  check('a passcode that is too short is refused', (await page.$eval('[data-security-message]', (e) => e.textContent ?? '')).includes('at least'));
  await page.fill('[data-lock-new]', 'sesame');
  await page.fill('[data-lock-repeat]', 'sesamf');
  await page.click('[data-lock-save]');
  check('so is one typed differently twice', (await page.$eval('[data-security-message]', (e) => e.textContent ?? '')).includes('not the same'));
  await page.fill('[data-lock-repeat]', 'sesame');
  await page.click('[data-lock-save]');
  await page.waitForSelector('[data-lock-now]', { timeout: 5_000 });
  check('a good one turns it on and leaves the app open', (await page.$('[data-lock-screen]')) === null && (await page.$eval('[data-security-note]', (e) => e.textContent ?? '')).includes('cannot be recovered'));
  const stored = await page.evaluate(() => localStorage.getItem('notes.lock.v1') ?? '');
  check('what is kept is a hash, not the passcode', stored.includes('"hash"') && !stored.includes('sesame'));
  await page.click('[data-security-close]');

  // Start-up.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-lock-screen]', { timeout: 10_000 });
  check('it is locked when the app starts', true);
  check('the library behind it cannot be reached', await page.evaluate(() => { const v = document.querySelector('[data-library-view]'); return !v || !!v.closest('[inert]'); }));
  const covers = await page.evaluate(() => { const r = document.querySelector('[data-lock-screen]').getBoundingClientRect(); return r.width >= innerWidth && r.height >= innerHeight; });
  check('and the lock screen covers all of it', covers);

  await page.fill('[data-lock-input]', 'wrong');
  await page.click('[data-lock-submit]');
  await page.waitForFunction(() => (document.querySelector('[data-lock-message]')?.textContent ?? '').includes('not the right'), null, { timeout: 5_000 });
  check('a wrong passcode says so and stays locked', (await page.$('[data-lock-screen]')) !== null);

  await page.evaluate(() => { window.__keys = 0; window.addEventListener('keydown', () => { window.__keys += 1; }); });
  await page.keyboard.press('z');
  check('keys typed while locked go only to the lock screen', (await page.evaluate(() => window.__keys)) === 0);

  await page.fill('[data-lock-input]', 'sesame');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-lock-screen]', { state: 'detached', timeout: 5_000 });
  check('the right passcode opens it', (await page.$('[data-library-view]')) !== null);
  await page.mouse.click(600, 600);
  await page.keyboard.press('z');
  check('and keys reach the app again', (await page.evaluate(() => window.__keys)) >= 1);

  // Locking at once.
  await page.keyboard.press('Control+Shift+L');
  await page.waitForSelector('[data-lock-screen]', { timeout: 3_000 });
  check('Ctrl+Shift+L locks it at once', true);
  await page.fill('[data-lock-input]', 'sesame');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-lock-screen]', { state: 'detached', timeout: 5_000 });

  // After a time away.
  await page.click('[data-security-settings]');
  await page.selectOption('[data-auto-lock]', '5');
  await page.click('[data-security-close]');
  await page.clock.fastForward('03:00');
  check('a few minutes idle is not enough for five', (await page.$('[data-lock-screen]')) === null);
  await page.clock.fastForward('03:00');
  await page.waitForSelector('[data-lock-screen]', { timeout: 3_000 });
  check('six minutes of not using it locks it', true);
  await page.fill('[data-lock-input]', 'sesame');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-lock-screen]', { state: 'detached', timeout: 5_000 });

  // Changing and turning off.
  await page.click('[data-security-settings]');
  await page.click('[data-lock-change]');
  await page.fill('[data-lock-current]', 'nope');
  await page.fill('[data-lock-new]', 'newcode');
  await page.fill('[data-lock-repeat]', 'newcode');
  await page.click('[data-lock-save]');
  await page.waitForFunction(() => (document.querySelector('[data-security-message]')?.textContent ?? '').includes('not the current'), null, { timeout: 5_000 }).catch(() => {});
  check('changing it needs the current passcode', (await page.$eval('[data-security-message]', (e) => e.textContent ?? '')).includes('not the current'));
  await page.fill('[data-lock-current]', 'sesame');
  await page.click('[data-lock-save]');
  await page.waitForFunction(() => (document.querySelector('[data-security-message]')?.textContent ?? '').includes('changed'), null, { timeout: 5_000 });
  check('and then it is changed', true);
  await page.click('[data-lock-off]');
  await page.fill('[data-lock-current]', 'sesame');
  await page.click('[data-lock-save]');
  await page.waitForFunction(() => (document.querySelector('[data-security-message]')?.textContent ?? '').includes('not the current'), null, { timeout: 5_000 }).catch(() => {});
  check('the old passcode no longer turns it off', (await page.$eval('[data-security-message]', (e) => e.textContent ?? '')).includes('not the current') && (await page.$('[data-lock-now]')) !== null);
  await page.fill('[data-lock-current]', 'newcode');
  await page.click('[data-lock-save]');
  await page.waitForSelector('[data-lock-new]', { timeout: 5_000 });
  check('the new one does', (await page.evaluate(() => localStorage.getItem('notes.lock.v1') ?? '')).includes('"record":null'));
  await page.click('[data-security-close]');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-library-view]', { timeout: 10_000 });
  check('and the app starts open again', (await page.$('[data-lock-screen]')) === null);

  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * Bookmarks: marking the page in view, the list, naming, jumping, the ribbon on the page and on its
 * thumbnail, Ctrl+D, and what happens to them when a note is saved and opened.
 */
async function checkBookmarks(browser) {
  console.log('bookmarks, 1280x800:');
  const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openDocument(page);
  // Three pages, made from the arranger's own buttons.
  await page.click('[data-arranger-toggle]');
  await page.waitForSelector('[role="group"][aria-label="Page operations"] button');
  const addAfter = page.locator('[role="group"][aria-label="Page operations"] button', { hasText: /after/i }).first();
  await addAfter.click();
  await addAfter.click();
  await page.waitForFunction(() => document.querySelectorAll('[data-thumbnail]').length === 3);
  await page.click('[data-arranger-close]');
  await page.waitForTimeout(200);

  const goTo = async (n) => {
    await page.click('[data-page-badge]');
    await page.fill('input[aria-label="Jump to page"]', String(n));
    await page.keyboard.press('Enter');
    await page.waitForFunction((n) => new RegExp(`(^|\\D)${n}\\s*/\\s*3`).test(document.querySelector('[data-page-badge]')?.textContent ?? ''), n, { timeout: 5_000 });
  };
  await goTo(1);

  check('there is no bookmark panel until asked for', (await page.$('[data-bookmarks-panel]')) === null);
  check('and no ribbon on any page', (await page.$('[data-bookmark-ribbon]')) === null);
  await page.click('[data-bookmarks-toggle]');
  await page.waitForSelector('[data-bookmarks-panel]');
  check('with none it says how to begin', (await page.$('[data-bookmarks-empty]')) !== null);
  await page.click('[data-bookmark-toggle-here]');
  await page.waitForSelector('[data-bookmark]');
  check('the button bookmarks the page in view', (await page.$$('[data-bookmark]')).length === 1 && (await page.$eval('[data-bookmark]', (e) => e.getAttribute('data-bookmark'))) === '0');
  check('the note is marked as changed', (await page.$('[data-dirty]')) !== null);
  check('the page shows a ribbon', (await page.$('[data-bookmark-ribbon]')) !== null);
  check('and the top bar button shows it is bookmarked', (await page.$('[data-bookmarks-toggle] svg.lucide-bookmark-check')) !== null);

  // Name it.
  await page.fill('[data-bookmark-name]', 'Start here');
  check('it can be named', (await page.$eval('[data-bookmark-name]', (e) => e.value)) === 'Start here');

  // A second, made on another page with Ctrl+D (after the panel has let go of the keys).
  await goTo(3);
  await page.mouse.click(40, 400);
  await page.keyboard.press('Control+d');
  await page.waitForFunction(() => document.querySelectorAll('[data-bookmark]').length === 2);
  check('Ctrl+D bookmarks the page in view', (await page.$$eval('[data-bookmark]', (els) => els.map((e) => e.getAttribute('data-bookmark')))).join() === '0,2');
  check('the list is in page order, the unnamed one reading as its page', (await page.$$eval('[data-bookmark-name]', (els) => els.map((e) => e.placeholder))).join() === 'Page 1,Page 3');

  // Jump.
  await page.click('[data-bookmark="0"] [data-bookmark-go]');
  await page.waitForFunction(() => /(^|\D)1\s*\/\s*3/.test(document.querySelector('[data-page-badge]')?.textContent ?? ''), null, { timeout: 5_000 });
  check('choosing a bookmark goes to its page', true);

  // The thumbnails carry it. Opening the arranger puts the panel away, which shares its side of the screen.
  await page.click('[data-arranger-toggle]');
  await page.waitForFunction(() => document.querySelector('[data-bookmarks-panel]') === null);
  check('opening the page arranger puts the bookmarks panel away', true);
  await page.waitForSelector('[data-thumbnail-bookmark]');
  check('the thumbnails of bookmarked pages carry a mark, and only those', (await page.$$('[data-thumbnail-bookmark]')).length === 2);
  check('and a bookmark\'s name', (await page.$eval('[data-thumbnail-index="0"]', (e) => e.textContent ?? '')).includes('Start here'));
  await page.click('[data-arranger-close]');

  // Remove.
  await page.click('[data-bookmarks-toggle]');
  await page.waitForSelector('[data-bookmark="2"]');
  await page.click('[data-bookmark="2"] [data-bookmark-remove]');
  await page.waitForFunction(() => document.querySelectorAll('[data-bookmark]').length === 1);
  check('a bookmark can be removed from the list', true);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  check('Esc puts the panel away', (await page.$('[data-bookmarks-panel]')) === null);

  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * Favourites and tags in the library: the star, the tag dialog, the chips, views across the library,
 * they survive a reload, and go when a note does.
 */
async function checkLibraryOrganising(browser) {
  console.log('favourites and tags, 1280x800:');
  const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  for (let n = 0; n < 2; n++) {
    await page.waitForSelector('[data-new-document]');
    await page.click('[data-new-document]');
    await page.waitForSelector('[data-back-to-library]', { timeout: 10_000 });
    await page.click('[data-back-to-library]');
    await page.waitForSelector('[data-library-view]');
  }
  await page.waitForFunction(() => document.querySelectorAll('[data-library-kind="document"]').length === 2);
  const cards = page.locator('[data-library-kind="document"]');
  const cardCount = async () => (await page.$$('[data-library-kind="document"]')).length;

  check('with nothing starred or tagged there is no filter bar', (await page.$('[data-library-filters]')) === null);
  check('but every note has a star and a tag button', (await page.$$('[data-card-favourite]')).length === 2 && (await page.$$('[data-card-tags-button]')).length === 2);

  await cards.nth(0).locator('[data-card-favourite]').click();
  await page.waitForSelector('[data-library-filters]');
  check('starring a note does not open it', (await page.$('[data-library-view]')) !== null);
  check('the star shows as set', (await cards.nth(0).locator('[data-card-favourite]').getAttribute('aria-pressed')) === 'true');
  check('and the filter bar offers the favourites', (await page.$('[data-library-filter="fav"]')) !== null);

  // Tags, through the dialog.
  await cards.nth(0).locator('[data-card-tags-button]').click();
  await page.waitForSelector('[data-tags-dialog]');
  await page.fill('[data-tags-input]', 'school, Maths');
  await page.click('[data-tags-save]');
  await page.waitForSelector('[data-card-tags]');
  check('tags appear on the card', (await cards.nth(0).locator('[data-card-tags]').textContent()).includes('school'));
  check('and as filters, each with how many notes carry it', (await page.$('[data-library-filter="tag:school"]')) !== null && (await page.$('[data-library-filter="tag:Maths"]')) !== null);

  // A tag already in use is a tap away on the other note.
  await cards.nth(1).locator('[data-card-tags-button]').click();
  await page.waitForSelector('[data-tag-suggestion="school"]');
  await page.click('[data-tag-suggestion="school"]');
  check('a tag in use is offered as a suggestion, and taking it fills it in', (await page.$eval('[data-tags-input]', (e) => e.value)) === 'school');
  await page.click('[data-tags-save]');
  await page.waitForFunction(() => (document.querySelector('[data-library-filter="tag:school"]')?.textContent ?? '').includes('2'));
  check('now two notes carry it', true);

  // The views.
  await page.click('[data-library-filter="fav"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-library-kind="document"]').length === 1);
  check('Favourites shows only the starred note', (await cardCount()) === 1);
  await page.click('[data-library-filter="tag:school"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-library-kind="document"]').length === 2);
  check('a tag shows the notes that have it', (await cardCount()) === 2);
  await page.click('[data-library-filter="tag:Maths"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-library-kind="document"]').length === 1);
  check('and only those', (await cardCount()) === 1);
  check('the chip in use says so', (await page.getAttribute('[data-library-filter="tag:Maths"]', 'aria-pressed')) === 'true');
  await page.click('[data-library-filter="all"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-library-kind="document"]').length === 2);

  // Kept.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-library-filters]');
  check('they are still there after a restart', (await page.$('[data-library-filter="fav"]')) !== null && (await page.$('[data-library-filter="tag:Maths"]')) !== null);

  // Taking the last star away leaves the view it was in.
  await page.click('[data-library-filter="fav"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-library-kind="document"]').length === 1);
  await cards.nth(0).locator('[data-card-favourite]').click();
  await page.waitForFunction(() => document.querySelector('[data-library-filter="fav"]') === null);
  await page.waitForFunction(() => document.querySelectorAll('[data-library-kind="document"]').length === 2);
  check('with no favourites left the view goes back to all the notes', (await cardCount()) === 2);

  // Deleting a note takes its tags with it.
  await cards.nth(0).click({ button: 'right' });
  await page.waitForFunction(() => document.querySelectorAll('[data-library-kind="document"]').length === 1);
  await page.waitForFunction(() => (document.querySelector('[data-library-filter="tag:school"]')?.textContent ?? '').includes('1'));
  check('deleting a note takes its tags with it', true);

  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/** A small valid PDF of `count` pages, each with a line of text, as bytes. */
/**
 * A small PDF built by hand: `count` US-letter pages, each saying "<label> page N" in large type at the top.
 * `opts.lines(i)` adds lines of 14 pt text under that, 24 pt apart from y = 640 down; `opts.outline` gives it a table
 * of contents, entries `{ title, page, top?, items? }` with `page` 0-based and `top` a PDF y (an /XYZ destination)
 * or absent (/Fit).
 */
function tinyPdf(count, label = 'Lecture', opts = {}) {
  const objects = [];
  const add = (body) => objects.push(body) && objects.length;
  const catalog = add('');
  const pagesRoot = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const escape = (t) => t.replace(/[\\()]/g, (c) => `\\${c}`);
  const kids = [];
  for (let i = 0; i < count; i++) {
    let text = `BT /F1 36 Tf 60 700 Td (${escape(`${label} page ${i + 1}`)}) Tj ET`;
    (opts.lines?.(i) ?? []).forEach((line, k) => {
      text += `\nBT /F1 14 Tf 60 ${640 - k * 24} Td (${escape(line)}) Tj ET`;
    });
    const content = add(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesRoot} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
  }
  let outlines = '';
  if (opts.outline?.length) {
    const root = add('');
    const build = (entries, parent) => {
      const ids = entries.map(() => add(''));
      entries.forEach((entry, k) => {
        const dest = entry.top === undefined ? `[${kids[entry.page]} 0 R /Fit]` : `[${kids[entry.page]} 0 R /XYZ 0 ${entry.top} 0]`;
        const children = entry.items?.length ? build(entry.items, ids[k]) : null;
        objects[ids[k] - 1] =
          `<< /Title (${escape(entry.title)}) /Parent ${parent} 0 R /Dest ${dest}` +
          (k > 0 ? ` /Prev ${ids[k - 1]} 0 R` : '') +
          (k < ids.length - 1 ? ` /Next ${ids[k + 1]} 0 R` : '') +
          (children ? ` /First ${children[0]} 0 R /Last ${children[children.length - 1]} 0 R /Count ${children.length}` : '') +
          ' >>';
      });
      return ids;
    };
    const top = build(opts.outline, root);
    objects[root - 1] = `<< /Type /Outlines /First ${top[0]} 0 R /Last ${top[top.length - 1]} 0 R /Count ${top.length} >>`;
    outlines = ` /Outlines ${root} 0 R`;
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesRoot} 0 R${outlines} >>`;
  objects[pagesRoot - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${count} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Array.from(Buffer.from(out, 'latin1'));
}

/**
 * A PDF dropped where nothing is open becomes the document to write on; one dropped on a note with work in it is
 * another tab, not split until asked; the split button on a tab shows it beside the note (and on another tab changes
 * what the pane shows while the note stays the editor); the two sides can swap places, and so can reading and
 * writing; and Undo takes back pages added with Import.
 */
async function checkReadingDrop(browser) {
  console.log('dropping PDFs, tabs and the split screen, 1280x800:');
  const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openDocument(page);
  await page.waitForSelector('[data-insert-trigger]', { timeout: 10_000 });
  const badge = () => page.$eval('[data-page-badge]', (e) => e.textContent.replace(/\s+/g, ' ').trim());
  const title = () => page.$eval('[data-title]', (e) => e.value);
  const pdfTransfer = (name, pages) =>
    page.evaluateHandle(({ name, bytes }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], name, { type: 'application/pdf' }));
      return transfer;
    }, { name, bytes: tinyPdf(pages, name.replace(/\.pdf$/, '')) });
  const dropPdf = async (name, pages) => {
    const t = await pdfTransfer(name, pages);
    await page.dispatchEvent('[data-page-stage]', 'dragover', { dataTransfer: t });
    await page.dispatchEvent('[data-page-stage]', 'drop', { dataTransfer: t });
  };
  const tabText = () => page.$$eval('[data-tab]', (els) => els.map((e) => e.textContent.trim()));
  const activeTab = () => page.$eval('[data-tab][data-tab-active]', (e) => e.textContent.trim());

  // Nothing but a blank new note: the PDF is the thing to write on.
  await dropPdf('Lecture 3.pdf', 2);
  await page.waitForFunction(() => /Lecture/.test(document.querySelector('[data-title]')?.value ?? ''), null, { timeout: 15_000 });
  check('on a blank note, a dropped PDF is the document to write on', (await page.$$('[data-tab]')).length === 0 && (await badge()).endsWith('/ 2'), `${await title()} ${await badge()}`);
  check('it is that note, now with unsaved pages, not a second one', (await page.$('[data-dirty]')) !== null);
  check('with no pane and no extra tab', (await page.$('[data-reference-pane]')) === null);

  // A second PDF, with work already in the first: another tab, not split.
  await page.fill('[data-title]', 'Lecture notes');
  await dropPdf('Exercises.pdf', 1);
  await page.waitForFunction(() => document.querySelectorAll('[data-tab]').length === 2, null, { timeout: 15_000 });
  check('a second PDF is another tab', (await tabText()).length === 2);
  check('and the first is still the one being written in', (await title()) === 'Lecture notes' && /Lecture notes/.test(await activeTab()));
  check('it is not split', (await page.$('[data-reference-pane]')) === null);
  const notice = await page.$eval('[data-notice], [data-notice-toast]', (e) => e.textContent ?? '');
  check('the notice says so and offers the split', notice.includes('in a new tab') && notice.includes('Split screen'), notice);
  check('the other tab has the split-screen button', (await page.$$('[data-tab-split]')).length === 1);

  // The button on its tab splits the screen.
  await page.click('[data-tab-split]');
  await page.waitForSelector('[data-reference-pane]', { timeout: 10_000 });
  check('the split-screen button shows it beside the note', (await page.textContent('[data-reference-title]')).includes('Exercises'));
  check('with the note still the editor', (await title()) === 'Lecture notes');

  // A third PDF: another tab, and the pane keeps what it had until a different tab's button is pressed.
  await dropPdf('Sheet 2.pdf', 1);
  await page.waitForFunction(() => document.querySelectorAll('[data-tab]').length === 3, null, { timeout: 15_000 });
  check('a third PDF is a third tab and leaves the pane as it was', (await page.textContent('[data-reference-title]')).includes('Exercises') && (await title()) === 'Lecture notes');
  await page.click('[data-tab]:has-text("Sheet 2") [data-tab-split]');
  await page.waitForFunction(() => /Sheet 2/.test(document.querySelector('[data-reference-title]')?.textContent ?? ''), null, { timeout: 10_000 });
  check('the split button on another tab changes what the pane shows', true);
  check('while the note stays the one being written in', (await title()) === 'Lecture notes' && /Lecture notes/.test(await activeTab()));

  // Sides.
  const box = (sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.x, w: r.width }; });
  const editorBefore = await box('[data-page-stage]');
  const paneBefore = await box('[data-reference-pane]');
  check('the pane starts on the right', paneBefore.x > editorBefore.x);
  check('and fills the rest of the window, with no empty strip beside it', Math.abs(paneBefore.x + paneBefore.w - DESKTOP.width) < 3, `ends at ${Math.round(paneBefore.x + paneBefore.w)} of ${DESKTOP.width}`);
  await page.click('[data-reference-swap-sides]');
  await page.waitForTimeout(150);
  const editorAfter = await box('[data-page-stage]');
  const paneAfter = await box('[data-reference-pane]');
  check('the swap button puts the pane on the left and the note on the right', paneAfter.x < editorAfter.x, `${Math.round(paneAfter.x)} vs ${Math.round(editorAfter.x)}`);
  check('and on the left it fills to the edge as well', paneAfter.x < 3, `starts at ${Math.round(paneAfter.x)}`);
  check('each keeps its role: the note is still the editor', (await title()) === 'Lecture notes');
  // The divider drags the right way round on this side.
  const divider = await (await page.$('[data-split-divider]')).boundingBox();
  const stageBefore = await box('[data-page-stage]');
  await page.mouse.move(divider.x + divider.width / 2, divider.y + 200);
  await page.mouse.down();
  await page.mouse.move(divider.x + divider.width / 2 + 120, divider.y + 200, { steps: 6 });
  await page.mouse.up();
  const stageAfter = await box('[data-page-stage]');
  check('dragging the divider towards the pane makes the editor wider, whichever side it is on', stageAfter.w < stageBefore.w, `${Math.round(stageBefore.w)} -> ${Math.round(stageAfter.w)}`);
  await page.click('[data-reference-swap-sides]');
  await page.waitForTimeout(150);
  check('and back', (await box('[data-reference-pane]')).x > (await box('[data-page-stage]')).x);

  // Roles: read the note, write on the PDF.
  await page.click('[data-reference-swap-roles]');
  await page.waitForFunction(() => /Sheet 2/.test(document.querySelector('[data-title]')?.value ?? ''), null, { timeout: 10_000 });
  check('the swap-roles button makes the pane\'s document the one being written in', (await title()).includes('Sheet 2'));
  check('and the note goes into the pane to be read, unsaved changes and all', /Lecture notes/.test(await page.textContent('[data-reference-title]')));
  // Clicking the tab that is in the pane does the same.
  await page.click('[data-tab]:has-text("Lecture notes") button[role="tab"]');
  await page.waitForFunction(() => /Lecture notes/.test(document.querySelector('[data-title]')?.value ?? ''), null, { timeout: 10_000 });
  check('clicking the tab in the pane swaps them back', /Sheet 2/.test(await page.textContent('[data-reference-title]')));

  // Zoomed in, the pane scrolls both ways: no part of a page is out of reach on the left.
  const reach = () =>
    page.$eval('[data-reference-scroll]', (scroller) => {
      const frame = scroller.querySelector('[data-reference-page-frame]');
      const view = scroller.getBoundingClientRect();
      scroller.scrollLeft = 0;
      const atLeft = frame.getBoundingClientRect();
      const leftClipped = Math.round(view.left - atLeft.left);
      scroller.scrollLeft = scroller.scrollWidth;
      const atRight = frame.getBoundingClientRect();
      const rightClipped = Math.round(atRight.right - view.right);
      return { leftClipped, rightClipped, scrollable: scroller.scrollWidth - scroller.clientWidth };
    });
  const before = await reach();
  check('at the normal zoom the page fits the pane and there is nothing to scroll sideways', before.scrollable <= 1 && before.leftClipped <= 1, JSON.stringify(before));
  for (let i = 0; i < 8; i += 1) await page.click('[data-reference-pane] [aria-label="Zoom in"]');
  await page.waitForTimeout(150);
  const middle = await page.$eval('[data-reference-scroll]', (e) => ({ left: e.scrollLeft, mid: (e.scrollWidth - e.clientWidth) / 2 }));
  check('zooming in keeps the middle of the page in view, not its left edge', Math.abs(middle.left - middle.mid) < 4, JSON.stringify(middle));
  const zoomed = await reach();
  check('zoomed in, the pane scrolls sideways', zoomed.scrollable > 100, JSON.stringify(zoomed));
  check('and the left edge of the page can be scrolled to', zoomed.leftClipped <= 1, `${zoomed.leftClipped}px of its left is out of reach`);
  check('as can the right edge', zoomed.rightClipped <= 1, `${zoomed.rightClipped}px of its right is out of reach`);
  for (let i = 0; i < 8; i += 1) await page.click('[data-reference-pane] [aria-label="Zoom out"]');

  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * A PDF's own table of contents: the Contents button appears for a note made from a PDF, an entry goes to its page
 * (and as far down it as its heading), a nested entry folds away, and the reading pane has the same list for the
 * document beside the note.
 */
async function checkContents(browser) {
  console.log('a PDF\'s table of contents, 1280x800:');
  const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openDocument(page);
  await page.waitForSelector('[data-insert-trigger]', { timeout: 10_000 });
  const badge = () => page.$eval('[data-page-badge]', (e) => e.textContent.replace(/\s+/g, ' ').trim());
  const dropPdf = async (name, count, opts) => {
    const t = await page.evaluateHandle(({ name, bytes }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], name, { type: 'application/pdf' }));
      return transfer;
    }, { name, bytes: tinyPdf(count, name.replace(/\.pdf$/, ''), opts) });
    await page.dispatchEvent('[data-page-stage]', 'dragover', { dataTransfer: t });
    await page.dispatchEvent('[data-page-stage]', 'drop', { dataTransfer: t });
  };

  check('a plain note has no Contents button', (await page.$('[data-contents-toggle]')) === null);
  await dropPdf('Lecture 5.pdf', 6, {
    outline: [
      { title: 'Introduction', page: 0 },
      { title: 'Fourier series', page: 2, top: 300, items: [{ title: 'Coefficients', page: 3 }, { title: 'Convergence', page: 4 }] },
      { title: 'Summary', page: 5 },
    ],
  });
  await page.waitForFunction(() => /\/ 6/.test(document.querySelector('[data-page-badge]')?.textContent ?? ''), null, { timeout: 15_000 });
  await page.waitForSelector('[data-contents-toggle]', { timeout: 5_000 });
  check('a note made from a PDF has one', true);
  await page.click('[data-contents-toggle]');
  await page.waitForSelector('[data-contents-row]', { timeout: 10_000 });
  const rows = await page.$$eval('[data-contents-row]', (els) => els.map((e) => e.textContent.trim()));
  check('it lists the PDF\'s chapters, nested ones too, with their pages', rows.length === 5 && rows[1].includes('Fourier series') && rows[1].endsWith('3') && rows[2].includes('Coefficients'), rows.join(' | '));
  check('the chapter in view is marked', (await page.$eval('[data-contents-current]', (e) => e.textContent)).includes('Introduction'));

  await page.click('[data-contents-row="1"] [data-contents-go]');
  await page.waitForFunction(() => /\b3 \/ 6/.test(document.querySelector('[data-page-badge]')?.textContent ?? ''), null, { timeout: 5_000 }).catch(() => {});
  check('an entry goes to its page', /\b3 \/ 6/.test(await badge()), await badge());
  await page.waitForTimeout(200);
  const offset = await page.evaluate(() => {
    const viewer = document.querySelector('[data-viewer]').getBoundingClientRect();
    const frame = document.querySelector('[data-page-index="2"]').getBoundingClientRect();
    return Math.round(frame.top - viewer.top);
  });
  // The heading is at y = 300 of 792: about 60% of the way down the page, so the page's top is well above the view.
  check('and as far down it as its heading', offset < -200, `page top ${offset}px from the top of the view`);
  check('which is now the one marked', (await page.$eval('[data-contents-current]', (e) => e.textContent)).includes('Fourier series'));

  await page.click('[data-contents-row="1"] [data-contents-fold]');
  check('a chapter folds what is under it', (await page.$$('[data-contents-row]')).length === 3);
  await page.click('[data-search-toggle]');
  const searchShown = await page.waitForSelector('[data-search-panel]', { timeout: 5_000 }).then(() => true, () => false);
  check('opening the search puts the contents away', searchShown && (await page.$('[data-contents-panel]')) === null);
  await page.click('[data-search-toggle]');

  // The reading pane.
  await page.keyboard.press('Escape');
  await dropPdf('Exercises.pdf', 6, { outline: [{ title: 'Sheet A', page: 0 }, { title: 'Sheet B', page: 2 }] });
  await page.waitForFunction(() => document.querySelectorAll('[data-tab]').length === 2, null, { timeout: 15_000 });
  await page.click('[data-tab-split]');
  await page.waitForSelector('[data-reference-contents]', { timeout: 10_000 });
  check('the reading pane has a Contents button for its PDF', true);
  await page.click('[data-reference-contents]');
  await page.waitForSelector('[data-reference-contents-list] [data-contents-row]', { timeout: 10_000 });
  const paneRows = await page.$$eval('[data-reference-contents-list] [data-contents-row]', (els) => els.map((e) => e.textContent.trim()));
  check('listing that PDF\'s chapters, not the note\'s', paneRows.length === 2 && paneRows[1].includes('Sheet B'), paneRows.join(' | '));
  await page.click('[data-reference-contents-list] [data-contents-row="1"] [data-contents-go]');
  await page.waitForTimeout(200);
  check('an entry scrolls the pane to its page and closes the list', (await page.textContent('[data-reference-page]')).trim().startsWith('3') && (await page.$('[data-reference-contents-list]')) === null, await page.textContent('[data-reference-page]'));
  check('and the note stays where it was', /\b3 \/ 6/.test(await badge()), await badge());

  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * Selecting a PDF's text: a drag selects the words it passes over, Copy puts them on the clipboard, a colour
 * highlights them on the note (one Undo takes it off), a double click takes a word, Text box puts them on the page,
 * a finger drags a selection too, and in the reading pane the text can be taken but not marked.
 */
async function checkTextSelect(browser) {
  console.log('selecting a PDF\'s text, 1280x800:');
  const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openDocument(page);
  await page.waitForSelector('[data-insert-trigger]', { timeout: 10_000 });
  const dropPdf = async (name, count, opts) => {
    const t = await page.evaluateHandle(({ name, bytes }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], name, { type: 'application/pdf' }));
      return transfer;
    }, { name, bytes: tinyPdf(count, name.replace(/\.pdf$/, ''), opts) });
    await page.dispatchEvent('[data-page-stage]', 'dragover', { dataTransfer: t });
    await page.dispatchEvent('[data-page-stage]', 'drop', { dataTransfer: t });
  };
  const lines = () => ['Fourier series decompose a signal', 'into sines and cosines here.', 'A third line of text'];
  await dropPdf('Notes.pdf', 2, { lines });
  await page.waitForFunction(() => /\/ 2/.test(document.querySelector('[data-page-badge]')?.textContent ?? ''), null, { timeout: 15_000 });

  /** Where a PDF point (from the bottom left, in points) is on screen, on a page of the note or of the pane. */
  const at = (frameSelector, px, py) =>
    page.$eval(frameSelector, (el, [px, py]) => {
      const r = el.getBoundingClientRect();
      const preserve = Math.abs(r.height / r.width - 792 / 612) < 0.01;
      const k = preserve ? r.width / 612 : (r.width / 794) * Math.min(794 / 612, 1123 / 792);
      return { x: r.left + px * k, y: r.top + (792 - py) * k };
    }, [px, py]);
  const drag = async (frame, from, to) => {
    const a = await at(frame, ...from);
    const b = await at(frame, ...to);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
    await page.mouse.move(b.x, b.y, { steps: 4 });
    await page.mouse.up();
  };
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  const NOTE = '[data-page-index="0"]';
  const highlighted = () =>
    page.$eval(`${NOTE} canvas[data-layer="committed"]`, (c) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n++;
      return n;
    });

  check('a note made from a PDF has a Select text button', (await page.$('[data-select-text-toggle]')) !== null);
  await page.click('[data-select-text-toggle]');
  check('which turns selecting on', await page.evaluate(() => document.documentElement.dataset.textSelecting === 'true'));

  // From the start of the first line to partway along the second.
  await drag(NOTE, [61, 644], [92, 620]);
  await page.waitForSelector('[data-text-selection]', { timeout: 10_000 });
  check('a drag over the words selects them, shaded line by line', (await page.getAttribute('[data-text-selection]', 'data-text-selection')) === '2');
  await page.waitForFunction(() => {
    const bar = document.querySelector('[data-text-toolbar]');
    return bar && getComputedStyle(bar).visibility !== 'hidden';
  }, null, { timeout: 5_000 });
  check('and offers what to do with them', true);
  await page.click('[data-text-copy]');
  await page.waitForTimeout(100);
  const copied = await clipboard();
  check('Copy puts the words on the clipboard, lines as lines', copied.startsWith('Fourier series decompose a signal\ninto'), JSON.stringify(copied));

  check('nothing is marked on the page yet', (await highlighted()) === 0);
  await page.click('[data-text-highlight="yellow"]');
  await page.waitForTimeout(250);
  const marked = await highlighted();
  check('a colour highlights the lines on the note', marked > 500, `${marked} px`);
  check('and the selection goes', (await page.$('[data-text-selection]')) === null);
  await page.click('[data-undo]');
  await page.waitForTimeout(250);
  check('one Undo takes the highlight off again', (await highlighted()) === 0);

  // A double click takes one word: "sines" on the second line.
  const word = await at(NOTE, 100, 620);
  await page.mouse.dblclick(word.x, word.y);
  await page.waitForSelector('[data-text-selection]', { timeout: 5_000 });
  await page.click('[data-text-copy]');
  await page.waitForTimeout(100);
  check('a double click selects a word', (await clipboard()) === 'sines', JSON.stringify(await clipboard()));
  // A tap clears it.
  const blank = await at(NOTE, 400, 560);
  await page.mouse.click(blank.x, blank.y);
  await page.waitForTimeout(100);
  check('and a tap elsewhere clears it', (await page.$('[data-text-selection]')) === null);

  // A finger drags a selection as well.
  const f1 = await at(NOTE, 61, 620);
  const f2 = await at(NOTE, 200, 596);
  await page.evaluate(({ x, y, x2, y2 }) => {
    const el = document.elementFromPoint(x, y);
    const fire = (type, cx, cy) =>
      el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerType: 'touch', pointerId: 12, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: cx, clientY: cy }));
    fire('pointerdown', x, y);
    fire('pointermove', (x + x2) / 2, (y + y2) / 2);
    fire('pointermove', x2, y2);
    fire('pointerup', x2, y2);
  }, { x: f1.x, y: f1.y, x2: f2.x, y2: f2.y });
  const fingerShown = await page.waitForSelector('[data-text-selection]', { timeout: 5_000 }).then(() => true, () => false);
  check('a finger drag selects too', fingerShown);

  // Into a text box, under the words.
  const boxesBefore = (await page.$$('[data-media-kind="text"]')).length;
  await page.click('[data-text-to-box]');
  await page.waitForFunction((n) => document.querySelectorAll('[data-media-kind="text"]').length === n + 1, boxesBefore, { timeout: 5_000 });
  const boxText = await page.$eval('[data-media-kind="text"]', (e) => e.textContent);
  check('Text box puts the words on the page as a text box', boxText.includes('into sines'), boxText);
  check('and puts selecting away, so the box can be moved', await page.evaluate(() => document.documentElement.dataset.textSelecting === undefined));

  // The reading pane: text can be taken from it, not marked on it.
  await dropPdf('Paper.pdf', 2, { lines: () => ['The reading side has words', 'to borrow for the notes.'] });
  await page.waitForFunction(() => document.querySelectorAll('[data-tab]').length === 2, null, { timeout: 15_000 });
  await page.click('[data-tab-split]');
  await page.waitForSelector('[data-reference-select-text]', { timeout: 10_000 });
  await page.click('[data-reference-select-text]');
  const PANE = '[data-reference-page-frame]';
  await page.waitForSelector(PANE);
  await drag(PANE, [61, 644], [200, 640]);
  await page.waitForSelector(`${PANE} [data-text-selection]`, { timeout: 10_000 });
  check('in the reading pane a drag selects its text', true);
  check('which can be copied or reused but not highlighted there', (await page.$('[data-text-copy]')) !== null && (await page.$('[data-text-highlight]')) === null);
  const before = (await page.$$('[data-media-kind="text"]')).length;
  await page.click('[data-text-to-box]');
  await page.waitForFunction((n) => document.querySelectorAll('[data-media-kind="text"]').length === n + 1, before, { timeout: 5_000 });
  const added = await page.$$eval('[data-media-kind="text"]', (els) => els.map((e) => e.textContent));
  check('Text box from the pane puts them on the note being written in', added.some((t) => t.includes('The reading side')), added.join(' | '));

  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * The top bar on a phone and a tablet, with a PDF open (which adds Select text and Contents): it fits, nothing
 * overlaps or runs off the edge, and what has no room is in the More menu, which works.
 */
async function checkTopBarNarrow(browser) {
  for (const size of [{ width: PHONE.width, height: PHONE.height, name: 'phone', inMenu: 10 }, { width: 800, height: 1280, name: 'tablet', inMenu: 4 }]) {
    console.log(`the top bar on a ${size.name}, ${size.width}x${size.height}:`);
    const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, hasTouch: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openDocument(page);
    const t = await page.evaluateHandle(({ bytes }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], 'Slides.pdf', { type: 'application/pdf' }));
      return transfer;
    }, { bytes: tinyPdf(3, 'Slides', { outline: [{ title: 'One', page: 0 }] }) });
    await page.dispatchEvent('[data-page-stage]', 'dragover', { dataTransfer: t });
    await page.dispatchEvent('[data-page-stage]', 'drop', { dataTransfer: t });
    await page.waitForFunction(() => /\/ 3/.test(document.querySelector('[data-page-badge]')?.textContent ?? ''), null, { timeout: 15_000 });
    await page.waitForTimeout(300);
    const fit = await page.evaluate(() => {
      const bar = document.querySelector('[data-top-bar]');
      const off = [...bar.querySelectorAll('button')].filter((b) => b.offsetWidth > 0 && b.getBoundingClientRect().right > innerWidth + 1).map((b) => b.getAttribute('aria-label'));
      const badge = document.querySelector('[data-page-badge]').getBoundingClientRect();
      const search = document.querySelector('[data-search-toggle]').getBoundingClientRect();
      return { overflow: bar.scrollWidth - bar.clientWidth, off, gap: Math.round(search.left - badge.right) };
    });
    check('it fits the width, nothing off the edge', fit.overflow <= 0 && fit.off.length === 0, JSON.stringify(fit));
    check('and the page counter clears the buttons beside it', fit.gap >= 0, `${fit.gap}px`);
    await page.click('[data-top-bar-more]');
    await page.waitForSelector('[data-top-bar-more-menu]');
    const items = await page.$$eval('[data-top-bar-more-item]', (els) => els.filter((e) => e.offsetWidth > 0).map((e) => e.getAttribute('data-top-bar-more-item')));
    check('More lists what has no room in the bar', items.length === size.inMenu, items.join(', '));
    const onTop = await page.evaluate(() => {
      const menu = document.querySelector('[data-top-bar-more-menu]').getBoundingClientRect();
      const hit = document.elementFromPoint(menu.left + menu.width / 2, menu.top + 12);
      return Boolean(hit?.closest('[data-top-bar-more-menu]'));
    });
    check('above everything else on the screen', onTop);
    if (size.name === 'phone') {
      await page.click('[data-top-bar-more-item="snip"]');
      await page.waitForTimeout(150);
      check('choosing a row does it and closes the menu', (await page.$('[data-top-bar-more-menu]')) === null && (await page.$('[data-snip-hint]')) !== null);
      check('and More shows a dot while something in it is on', (await page.$('[data-top-bar-more-on]')) !== null);
    } else {
      await page.click('[data-top-bar-more-item="bookmarks"]');
      await page.waitForSelector('[data-bookmarks-panel]', { timeout: 5_000 });
      check('choosing a row does it and closes the menu', (await page.$('[data-top-bar-more-menu]')) === null);
    }
    check('no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
}

/**
 * Searchable handwriting, with the desktop shell faked and its recogniser standing in for Windows': an old note with
 * handwriting and no words is read once things are still, without being marked as changed; its words are found by
 * the search and pointed at on the page; writing more reads the page again; the language can be chosen; and turned
 * off, nothing more is read.
 */
async function checkHandwritingSearch(browser) {
  console.log('searching handwriting, 1280x800 (desktop shell and recogniser faked):');
  const seedCtx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  const seedPage = await seedCtx.newPage();
  await openDocument(seedPage);
  const blank = await seedPage.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('notes.library.doc.'));
    return localStorage.getItem(key);
  });
  await seedCtx.close();

  // Two lines of "handwriting" on page one: zigzags, the first at y = 200, the second at y = 420.
  const style = { color: '#111111', size: 3, opacity: 1, compositeOperation: 'source-over', thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: false, taperStart: 0, taperEnd: 0, pattern: 'solid', arrowheads: 'none' };
  const zigzag = (id, x0, y0) => {
    const points = Array.from({ length: 24 }, (_, i) => ({ x: x0 + i * 6, y: y0 + (i % 2 ? 18 : 0), pressure: 0.5 }));
    return { kind: 'freehand', id, tool: 'pen', points, style, bbox: { minX: x0 - 3, minY: y0 - 3, maxX: x0 + 141, maxY: y0 + 21 }, pointerType: 'pen', createdAt: 0 };
  };
  const envelope = JSON.parse(blank);
  envelope.document.title = 'Linear algebra';
  envelope.document.pages[0].strokes = [zigzag('s1', 100, 200), zigzag('s2', 260, 200), zigzag('s3', 100, 420)];
  const contents = JSON.stringify(envelope);

  const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  await ctx.addInitScript(({ contents }) => {
    const PATH = '/lib/Linear algebra.notex';
    window.__calls = [];
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    // The recogniser: strokes grouped into lines by height, each line one word.
    const LINE_WORDS = ['Eigenvalues', 'Determinant', 'Trace'];
    const recognize = (strokes) => {
      const boxes = strokes.map((s) => {
        const xs = s.points.filter((_, i) => i % 3 === 0);
        const ys = s.points.filter((_, i) => i % 3 === 1);
        return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
      }).sort((a, b) => a.y0 - b.y0);
      const lines = [];
      for (const b of boxes) {
        const line = lines.find((l) => Math.abs(l.y0 - b.y0) < 40);
        if (line) Object.assign(line, { x0: Math.min(line.x0, b.x0), y0: Math.min(line.y0, b.y0), x1: Math.max(line.x1, b.x1), y1: Math.max(line.y1, b.y1) });
        else lines.push({ ...b });
      }
      return lines.map((l, i) => ({ text: LINE_WORDS[i % LINE_WORDS.length], x: l.x0, y: l.y0, width: l.x1 - l.x0, height: l.y1 - l.y0 }));
    };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (cmd, args) => {
        window.__calls.push({ cmd, args });
        switch (cmd) {
          case 'list_library': return { path: '/lib', relativePath: '', parentPath: null, entries: [] };
          case 'create_library_document': return PATH;
          case 'open_document': return { path: PATH, contents, info: { path: PATH, bytes: contents.length, modifiedMs: 1 } };
          case 'ink_recognizers': return { names: ['Microsoft English (US) Handwriting Recognizer', 'Microsoft German Handwriting Recognizer'] };
          case 'recognize_ink': return recognize(args.strokes);
          case 'sync_status':
          case 'sync_now': return { phase: 'offline', provider: 'Not connected', pending: 0, conflicts: [], lastSyncedMs: 0, message: null };
          case 'list_recent': return [];
          default: return null;
        }
      },
    };
  }, { contents });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openDocument(page);
  await page.waitForFunction(() => document.querySelector('[data-title]')?.value === 'Linear algebra', null, { timeout: 10_000 });
  const reads = () => page.evaluate(() => window.__calls.filter((c) => c.cmd === 'recognize_ink'));

  await page.waitForFunction(() => window.__calls.some((c) => c.cmd === 'recognize_ink'), null, { timeout: 10_000 });
  const first = (await reads())[0];
  check('an old note\'s handwriting is read once things are still', first.args.strokes.length === 3, `${first.args.strokes.length} strokes`);
  check('every stroke sent as x, y, pressure', first.args.strokes.every((st) => st.points.length % 3 === 0 && st.points.length >= 6));
  check('with Windows\' own pick of language', first.args.recognizer === null);
  await page.waitForTimeout(300);
  check('and reading it does not mark the note as changed', (await page.$('[data-dirty]')) === null);

  await page.click('[data-search-toggle]');
  await page.waitForSelector('[data-search-input]');
  await page.fill('[data-search-input]', 'eigen');
  await page.waitForSelector('[data-search-hit]', { timeout: 5_000 });
  const hit = await page.$eval('[data-search-hit]', (e) => ({ kind: e.getAttribute('data-search-hit-kind'), text: e.textContent }));
  check('the search finds the handwritten word', hit.kind === 'ink' && hit.text.includes('Eigenvalues') && hit.text.includes('Handwriting'), JSON.stringify(hit));
  await page.fill('[data-search-input]', 'determinant');
  await page.waitForSelector('[data-search-hit]', { timeout: 5_000 });
  await page.click('[data-search-hit]');
  await page.waitForSelector('[data-search-flash]', { timeout: 3_000 });
  const ring = await page.evaluate(() => {
    const frame = document.querySelector('[data-page-index="0"]').getBoundingClientRect();
    const svg = document.querySelector('[data-search-flash]');
    const rect = svg.querySelector('rect').getBoundingClientRect();
    const k = frame.width / svg.viewBox.baseVal.width;
    return { top: Math.round((rect.top - frame.top) / k), left: Math.round((rect.left - frame.left) / k) };
  });
  // The second line's strokes start at (100, 420); the ring stands 6 units off the word.
  check('choosing it marks the word where it is on the page', Math.abs(ring.top - 414) <= 3 && Math.abs(ring.left - 94) <= 3, JSON.stringify(ring));
  await page.waitForSelector('[data-search-flash]', { state: 'detached', timeout: 4_000 });
  check('and the mark goes again', true);
  await page.click('[data-search-close]');

  // Writing more: the page is read again.
  const before = (await reads()).length;
  const frame = await (await page.$('[data-page-index="0"]')).boundingBox();
  await page.evaluate(() => {
    const canvas = document.querySelector('[data-page-index="0"] [data-layer="live"]');
    const fire = (type, x, y, buttons) => canvas.dispatchEvent(new PointerEvent(type, { pointerType: 'pen', pointerId: 7, isPrimary: true, bubbles: true, cancelable: true, clientX: x, clientY: y, buttons, button: type === 'pointermove' ? -1 : 0, pressure: buttons ? 0.5 : 0 }));
    window.__write = (x, y) => {
      fire('pointerdown', x, y, 1);
      for (let i = 1; i < 20; i++) fire('pointermove', x + i * 5, y + (i % 2) * 12, 1);
      fire('pointerup', x + 100, y, 0);
    };
  });
  await page.evaluate(({ x, y }) => window.__write(x, y), { x: frame.x + frame.width * 0.15, y: frame.y + frame.height * 0.6 });
  await page.waitForFunction((n) => window.__calls.filter((c) => c.cmd === 'recognize_ink').length > n, before, { timeout: 10_000 });
  check('writing more reads the page again', (await reads()).at(-1).args.strokes.length === 4);
  await page.fill('[data-search-input]', '').catch(() => {});

  // Settings: the language, and off.
  await page.click('[data-palette-settings-trigger]');
  await page.waitForSelector('[data-handwriting-search]', { timeout: 5_000 });
  const options = await page.$$eval('[data-handwriting-recognizer] option', (els) => els.map((e) => e.textContent));
  check('the settings offer the languages Windows has, by their short names', options.join('|') === 'Windows default|English (US)|German', options.join('|'));
  const note = await page.$eval('[data-handwriting-note]', (e) => e.textContent);
  check('and say how far this note is read', /Read on 1 of 1 page/.test(note), note);
  const n2 = (await reads()).length;
  await page.selectOption('[data-handwriting-recognizer]', 'Microsoft German Handwriting Recognizer');
  await page.waitForFunction((n) => window.__calls.filter((c) => c.cmd === 'recognize_ink').length > n, n2, { timeout: 10_000 });
  check('choosing a language reads the handwriting again in it', (await reads()).at(-1).args.recognizer === 'Microsoft German Handwriting Recognizer');
  await page.click('[data-handwriting-search]');
  await page.click('[data-palette-settings-trigger]');
  const n3 = (await reads()).length;
  await page.evaluate(({ x, y }) => window.__write(x, y), { x: frame.x + frame.width * 0.15, y: frame.y + frame.height * 0.75 });
  await page.waitForTimeout(2500);
  check('turned off, nothing more is read', (await reads()).length === n3);

  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * The snipping tool: cut a piece out of a PDF in the reference pane, put it on the note (with the button and by
 * dragging), take it off with Undo, snip in the editor itself without drawing, and carry one onto another tab.
 */
async function checkSnipping(browser) {
  console.log('snipping, 1280x800:');
  const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openDocument(page);
  await page.waitForSelector('[data-insert-trigger]', { timeout: 10_000 });
  await page.fill('[data-title]', 'My summary');
  // Some work on the note, so a PDF dropped on it is another tab and not the note's own pages.
  await page.click('[data-insert-trigger]');
  await page.click('[data-insert-text]');
  await page.waitForSelector('[data-text-content]');

  const transfer = await page.evaluateHandle(({ bytes }) => {
    const t = new DataTransfer();
    t.items.add(new File([new Uint8Array(bytes)], 'Exercises.pdf', { type: 'application/pdf' }));
    return t;
  }, { bytes: tinyPdf(2, 'Exercise') });
  await page.dispatchEvent('[data-page-stage]', 'drop', { dataTransfer: transfer });
  // Another tab, not split: the split screen is asked for with the button on its tab.
  await page.waitForSelector('[data-tab-split]', { timeout: 15_000 });
  await page.click('[data-tab-split]');
  await page.waitForSelector('[data-reference-page-frame] canvas[data-snapshot-ready="true"]', { timeout: 20_000 });
  const images = () => page.$$('[data-page-index="0"] [data-media-kind="image"]');
  const darkPixels = (selector) =>
    page.$eval(selector, async (img) => {
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 100 && d[i + 3] > 200) n++;
      return { n, w: c.width, h: c.height };
    });

  check('there is no tray until snipping is asked for', (await page.$('[data-snip-tray]')) === null);
  await page.click('[data-reference-snip]');
  await page.waitForSelector('[data-snip-hint]');
  check('the scissors in the pane turn snipping on, and the tray says what to do', true);

  // Cut round the first line of the PDF's text: it is drawn near the top left of the page.
  const frame = await (await page.$('[data-reference-page-frame]')).boundingBox();
  await page.mouse.move(frame.x + 10, frame.y + 20);
  await page.mouse.down();
  await page.mouse.move(frame.x + 150, frame.y + 60, { steps: 6 });
  check('a dashed rubber band follows the drag', (await page.$('[data-snip-marquee]')) !== null);
  await page.mouse.move(frame.x + 260, frame.y + 90, { steps: 6 });
  await page.mouse.up();
  await page.waitForSelector('[data-snip]', { timeout: 15_000 });
  check('letting go makes a snip, in the tray', (await page.$$('[data-snip]')).length === 1 && (await page.$('[data-snip-marquee]')) === null);
  const px = await darkPixels('[data-snip-image]');
  check('which holds what was under the drag: the words, at a readable size', px.n > 100 && px.w > 400, `${px.n} dark pixels, ${px.w}x${px.h}`);
  check('and cut from the page, nothing drawn on the note', (await images()).length === 0);

  // A click without a drag is not a snip.
  await page.mouse.click(frame.x + 100, frame.y + 300);
  check('a click is not a snip', (await page.$$('[data-snip]')).length === 1);

  // Done, then place with the button.
  await page.click('[data-snip-done]');
  check('Done turns snipping off and keeps the snips', (await page.$('[data-snip-hint]')) === null && (await page.$$('[data-snip]')).length === 1);
  await page.click('[data-snip-place]');
  await page.waitForSelector('[data-page-index="0"] [data-media-kind="image"]', { timeout: 5_000 });
  check('Place puts it on the note\'s page in view, as a picture', (await images()).length === 1);
  check('selected, so it can be moved at once', (await page.$('[data-media-toolbar]')) !== null);
  check('Undo is offered, and takes it off', await page.$eval('[data-undo]', (e) => !e.disabled));
  await page.click('[data-undo]');
  await page.waitForFunction(() => document.querySelectorAll('[data-page-index="0"] [data-media-kind="image"]').length === 0);
  check('the snip is gone from the page', true);
  check('and still in the tray', (await page.$$('[data-snip]')).length === 1);
  await page.click('[data-redo]');
  await page.waitForSelector('[data-page-index="0"] [data-media-kind="image"]');
  check('Redo puts it back', (await images()).length === 1);

  // Drag it out of the tray to a place on the page.
  const pageBox = await (await page.$('[data-page-index="0"]')).boundingBox();
  const thumb = await (await page.$('[data-snip-image]')).boundingBox();
  // Well above the toolbar, which floats over the lower part of the page.
  const dropX = pageBox.x + pageBox.width * 0.55;
  const dropY = pageBox.y + 260;
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
  await page.mouse.down();
  await page.mouse.move(thumb.x + thumb.width / 2 + 40, thumb.y + thumb.height / 2 + 40, { steps: 4 });
  check('while dragging, a copy follows the pointer', (await page.$('[data-snip-ghost]')) !== null);
  await page.mouse.move(dropX, dropY, { steps: 8 });
  check('and the page it is over is lit', (await page.$('[data-page-index="0"][data-snip-target]')) !== null);
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelectorAll('[data-page-index="0"] [data-media-kind="image"]').length === 2);
  check('dropping puts it on the page', (await images()).length === 2 && (await page.$('[data-snip-ghost]')) === null && (await page.$('[data-snip-target]')) === null);
  const placed = await (await images())[1].boundingBox();
  check('centred where it was dropped', Math.abs(placed.x + placed.width / 2 - dropX) < 14 && Math.abs(placed.y + placed.height / 2 - dropY) < 14, `${Math.round(placed.x + placed.width / 2 - dropX)}, ${Math.round(placed.y + placed.height / 2 - dropY)}`);

  // Held at the bottom edge of the page area, the pages scroll under it.
  const viewerBox = await (await page.$('[data-viewer]')).boundingBox();
  const scrollBefore = await page.$eval('[data-viewer]', (e) => e.scrollTop);
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
  await page.mouse.down();
  await page.mouse.move(viewerBox.x + viewerBox.width / 2, viewerBox.y + viewerBox.height - 6, { steps: 8 });
  await page.waitForTimeout(700);
  const scrollAfter = await page.$eval('[data-viewer]', (e) => e.scrollTop);
  check('a snip held at the bottom edge scrolls the pages down', scrollAfter > scrollBefore + 100, `${Math.round(scrollBefore)} -> ${Math.round(scrollAfter)}`);
  await page.mouse.move(viewerBox.x + viewerBox.width / 2, 30, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  check('and letting go over the top bar adds nothing', (await images()).length === 2);

  // Dropped on nothing, it stays in the tray and nothing is added.
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
  await page.mouse.down();
  await page.mouse.move(thumb.x + 60, 30, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  check('dropped on nothing it adds nothing', (await images()).length === 2 && (await page.$$('[data-snip]')).length === 1, `${(await images()).length} images, ${(await page.$$('[data-snip]')).length} snips`);

  // Snipping in the editor itself, without drawing.
  await page.click('[data-snip-toggle]');
  await page.waitForSelector('[data-snip-hint]');
  // The tray covers a corner of the page: it can be pulled out of the way by its title.
  const grip = await (await page.$('[data-snip-grip]')).boundingBox();
  await page.mouse.move(grip.x + 60, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + 60 + 120, grip.y + 120, { steps: 5 });
  await page.mouse.up();
  const moved = await (await page.$('[data-snip-grip]')).boundingBox();
  check('the tray can be pulled aside by its title', Math.abs(moved.x - grip.x - 120) < 4 && Math.abs(moved.y - grip.y - (120 - grip.height / 2)) < 4, `${Math.round(moved.x - grip.x)}, ${Math.round(moved.y - grip.y)}`);
  await page.mouse.move(pageBox.x + 300, pageBox.y + 40);
  await page.mouse.down();
  await page.mouse.move(pageBox.x + 480, pageBox.y + 160, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelectorAll('[data-snip]').length === 2, null, { timeout: 15_000 }).catch(async () => {
    console.log('   notice:', await page.$eval('[data-notice], [data-notice-toast]', (e) => e.textContent).catch(() => 'none'));
  });
  check('the top bar\'s scissors snip the page being written on', (await page.$$('[data-snip]')).length === 2);
  const strokeCount = await page.$eval('[data-page-index="0"] [data-layer="committed"]', (c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  }).catch(() => 0);
  check('and no ink was laid down by the drag', strokeCount === 0, String(strokeCount));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('[data-snip-hint]') === null);
  check('Esc stops snipping', true);

  // A finger drags out a snip as well: pointer events of a touch, over the pane's page.
  await page.click('[data-reference-snip]');
  await page.waitForSelector('[data-snip-hint]');
  check('while snipping, a finger cannot scroll the page it is dragged over', await page.$eval('[data-reference-page-frame] canvas', (c) => getComputedStyle(c).touchAction === 'none'));
  const fingerFrame = await (await page.$('[data-reference-page-frame]')).boundingBox();
  const snipsBefore = (await page.$$('[data-snip]')).length;
  await page.evaluate(({ x, y, x2, y2 }) => {
    const el = document.elementFromPoint(x, y);
    const fire = (type, cx, cy) =>
      el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerType: 'touch', pointerId: 11, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: cx, clientY: cy }));
    fire('pointerdown', x, y);
    fire('pointermove', (x + x2) / 2, (y + y2) / 2);
    fire('pointermove', x2, y2);
    fire('pointerup', x2, y2);
  }, { x: fingerFrame.x + 10, y: fingerFrame.y + 20, x2: fingerFrame.x + 230, y2: fingerFrame.y + 90 });
  await page.waitForFunction((n) => document.querySelectorAll('[data-snip]').length === n + 1, snipsBefore, { timeout: 15_000 });
  check('a finger drag over a page makes a snip', true);
  // A second finger landing in the middle of one ends it, rather than snipping something odd.
  const snipsMid = (await page.$$('[data-snip]')).length;
  await page.evaluate(({ x, y, x2, y2 }) => {
    const el = document.elementFromPoint(x, y);
    const fire = (type, id, cx, cy) =>
      el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerType: 'touch', pointerId: id, isPrimary: id === 21, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: cx, clientY: cy }));
    fire('pointerdown', 21, x, y);
    fire('pointermove', 21, x + 40, y + 20);
    fire('pointerdown', 22, x2, y2);
    fire('pointermove', 21, x + 150, y + 80);
    fire('pointerup', 21, x + 150, y + 80);
    fire('pointerup', 22, x2, y2);
  }, { x: fingerFrame.x + 10, y: fingerFrame.y + 120, x2: fingerFrame.x + 200, y2: fingerFrame.y + 200 });
  await page.waitForTimeout(400);
  check('a second finger ends the snip instead of making one', (await page.$$('[data-snip]')).length === snipsMid && (await page.$('[data-snip-marquee]')) === null);
  await page.click('[data-snip-done]');

  // Carry a snip to another tab: holding it over the tab opens it.
  const other = page.locator('[data-tab]:not([data-tab-active])').first();
  const tabBox = await other.boundingBox();
  const first = await (await page.$('[data-snip-image]')).boundingBox();
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(first.x + first.width / 2 + 30, first.y + first.height / 2 + 30, { steps: 3 });
  await page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2, { steps: 8 });
  check('a snip held over a tab marks it', (await page.$('[data-tab][data-snip-hover]')) !== null);
  await page.waitForFunction(() => /Exercises/.test(document.querySelector('[data-tab][data-tab-active]')?.textContent ?? ''), null, { timeout: 4_000 });
  await page.mouse.up();
  check('and after a moment opens that tab', true);
  check('the snips are still there in the other tab', (await page.$$('[data-snip]')).length === 3);

  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * Carrying a selection to the edge of the page area scrolls the pages, down a column and along a row, and the selection
 * follows the pen: it ends up where the pen let go, on whichever page is there.
 */
async function checkDragScroll(browser) {
  console.log('dragging a selection to the edge, 1280x800:');
  const { ctx, page, errors, cx, cy, around } = await openPenDocument(browser);
  // Pages enough to scroll through.
  await page.click('[data-arranger-toggle]');
  await page.waitForSelector('[role="group"][aria-label="Page operations"] button');
  const addAfter = page.locator('[role="group"][aria-label="Page operations"] button', { hasText: /after/i }).first();
  for (let i = 0; i < 3; i++) await addAfter.click();
  await page.click('[data-arranger-close]');
  await page.waitForTimeout(250);
  await page.click('[data-page-badge]');
  await page.fill('input[aria-label="Jump to page"]', '1');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);

  const scroll = () => page.$eval('[data-viewer]', (e) => ({ top: e.scrollTop, left: e.scrollLeft }));
  const select = async (x = cx, y = cy) => {
    const line = Array.from({ length: 20 }, (_, i) => [x - 60 + i * 6, y + (i % 2)]);
    await page.evaluate(([pts]) => window.__pen.stroke(pts, 1), [line]);
    await page.click('[data-palette-tool="lasso"]');
    const ring = [[x - 90, y - 30], [x + 90, y - 30], [x + 90, y + 30], [x - 90, y + 30], [x - 90, y - 30]].flatMap(([a, b], i, all) => {
      const n = all[i + 1];
      return n ? Array.from({ length: 8 }, (_, k) => [a + ((n[0] - a) * k) / 8, b + ((n[1] - b) * k) / 8]) : [[a, b]];
    });
    await page.evaluate(([pts]) => window.__pen.stroke(pts, 1), [ring]);
    await page.waitForSelector('[data-selection-box]', { timeout: 3_000 });
  };
  /** Drag the selection's body to (toX, toY), hold there, and let go. */
  const carry = (toX, toY, hold) =>
    page.evaluate(async ({ toX, toY, hold }) => {
      const el = document.querySelector('[data-selection-box]');
      const r = el.getBoundingClientRect();
      const x = r.x + r.width / 2;
      const y = r.y + r.height / 2;
      const send = (type, px, py, buttons, button) =>
        el.dispatchEvent(new PointerEvent(type, { pointerType: 'pen', pointerId: 9, isPrimary: true, bubbles: true, cancelable: true, clientX: px, clientY: py, buttons, button, pressure: buttons & 1 ? 0.5 : 0 }));
      send('pointerdown', x, y, 1, 0);
      for (let i = 1; i <= 10; i++) {
        send('pointermove', x + ((toX - x) * i) / 10, y + ((toY - y) * i) / 10, 1, -1);
        await new Promise((res) => setTimeout(res, 16));
      }
      await new Promise((res) => setTimeout(res, hold));
      send('pointerup', toX, toY, 0, 0);
    }, { toX, toY, hold });

  await select();
  const view = await (await page.$('[data-viewer]')).boundingBox();
  const before = await scroll();
  await carry(view.x + view.width / 2, view.y + view.height - 6, 900);
  const after = await scroll();
  check('held at the bottom edge, a selection scrolls the pages down', after.top > before.top + 150, `${Math.round(before.top)} -> ${Math.round(after.top)}`);
  await page.waitForSelector('[data-selection-box]', { timeout: 3_000 });
  const landed = await page.$eval('[data-selection-box]', (e) => { const r = e.getBoundingClientRect(); return r.y + r.height / 2; });
  check('and it lands where the pen let go, not where it was picked up', Math.abs(landed - (view.y + view.height - 6)) < 80, `${Math.round(landed)} vs ${Math.round(view.y + view.height - 6)}`);

  // And the other way, at the top edge.
  const mid = await scroll();
  await carry(view.x + view.width / 2, view.y + 6, 900);
  const up = await scroll();
  check('held at the top edge, it scrolls back up', up.top < mid.top - 100, `${Math.round(mid.top)} -> ${Math.round(up.top)}`);

  // A row of pages: along it.
  await page.click('[data-view-mode-toggle]');
  await page.waitForFunction(() => document.querySelector('[data-view-mode-toggle]')?.getAttribute('data-view-mode') === 'horizontal-continuous');
  await page.waitForTimeout(300);
  await page.click('[data-page-badge]');
  await page.fill('input[aria-label="Jump to page"]', '1');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const first = await (await page.$('[data-page-index="0"]')).boundingBox();
  await page.click('[data-palette-tool="pen"]').catch(() => {});
  await select(first.x + Math.min(first.width / 2, 300), first.y + 300);
  const row = await (await page.$('[data-viewer]')).boundingBox();
  const rowBefore = await scroll();
  await carry(row.x + row.width - 6, row.y + row.height / 2, 900);
  const rowAfter = await scroll();
  check('in a row of pages, held at the right edge, it scrolls along', rowAfter.left > rowBefore.left + 150, `${Math.round(rowBefore.left)} -> ${Math.round(rowAfter.left)}`);

  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * A screen that throws while drawing must say so, not leave a black window: a note whose table has no cells (damaged,
 * or written by something else) makes the page fail to draw, and what shows is the message, with the work intact.
 */
async function checkErrorBoundary(browser) {
  console.log('a screen that fails to draw, 1280x800:');
  const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  const page = await ctx.newPage();
  await openDocument(page);
  await page.click('[data-back-to-library]');
  await page.waitForSelector('[data-library-view]', { timeout: 10_000 });
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('notes.library.doc.'));
    const envelope = JSON.parse(localStorage.getItem(key));
    envelope.document.pages[0].media = [{ id: 'broken', kind: 'table', x: 50, y: 50, width: 300, height: 100, rotation: 0, zIndex: 1, rows: 2, columns: 2 }];
    localStorage.setItem(key, JSON.stringify(envelope));
  });
  await page.click('[data-library-kind="document"]');
  await page.waitForSelector('[data-error-boundary]', { timeout: 10_000 });
  check('the screen says something went wrong instead of going blank', (await page.textContent('[data-error-boundary]')).includes('Something went wrong showing this note'));
  const details = await page.textContent('[data-error-details]');
  check('and shows what went wrong, to be read out', /TypeError|Cannot read/i.test(details ?? ''), (details ?? '').slice(0, 80));
  check('with a way to try again and to reload', (await page.$('[data-error-retry]')) !== null);
  check('and the app around it is still there', (await page.$('#root')) !== null && (await page.$$('#root > div')).length === 1);
  await ctx.close();
}

/**
 * Turning a selection: the round handle above the box, and the quarter-turn buttons.
 * A flat line is the easiest thing to see turn: it ends up standing.
 */
async function checkRotate(browser) {
  console.log('rotating a selection, 1280x800:');
  const { ctx, page, errors, cx, cy, around } = await openPenDocument(browser);
  const box = () => page.$eval('[data-selection-box]', (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });

  const line = Array.from({ length: 30 }, (_, i) => [cx - 100 + i * (200 / 29), cy + (i / 29) * 2]);
  await page.evaluate(([pts]) => window.__pen.stroke(pts, 1), [line]);
  await page.click('[data-palette-tool="lasso"]');
  await page.evaluate(([pts]) => window.__pen.stroke(pts, 1), [around(140, 40)]);
  await page.waitForSelector('[data-selection-box]', { timeout: 3_000 });
  const flat = await box();
  check('a selection is offered a rotate handle', (await page.$('[data-selection-rotate]')) !== null);
  check('the line starts out flat', flat.w > flat.h * 3, `${Math.round(flat.w)}x${Math.round(flat.h)}`);

  const handle = await page.$eval('[data-selection-rotate]', (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  check('it stands above the box', handle.y < flat.y, `${Math.round(handle.y)} vs ${Math.round(flat.y)}`);
  check('and is not on top of the stretch handle', await page.$eval('[data-selection-handle="e"]', (el, h) => { const r = el.getBoundingClientRect(); return Math.hypot(r.x + r.width / 2 - h.x, r.y + r.height / 2 - h.y) > 20; }, handle));

  // A quarter of a circle round the middle of the box, from straight above to due east.
  const centre = { x: flat.x + flat.w / 2, y: flat.y + flat.h / 2 };
  const radius = centre.y - handle.y;
  const arc = Array.from({ length: 19 }, (_, i) => {
    const a = -Math.PI / 2 + (i / 18) * (Math.PI / 2);
    return [centre.x + radius * Math.cos(a), centre.y + radius * Math.sin(a)];
  });
  const turning = page.evaluate(([pts]) => window.__pen.drag('[data-selection-rotate]', pts), [arc]);
  let readout = '';
  for (let i = 0; i < 10 && !/\d/.test(readout); i++) {
    await page.waitForTimeout(30);
    readout = (await page.$eval('[data-selection-angle]', (el) => el.textContent).catch(() => '')) ?? '';
  }
  await turning;
  check('an angle is shown while it turns', /\d+°/.test(readout), readout);
  await page.waitForSelector('[data-selection-box]');
  const stood = await box();
  check('a quarter turn clockwise stands the line up', stood.h > stood.w * 3, `${Math.round(stood.w)}x${Math.round(stood.h)}`);
  check('about its middle, so it has not wandered off', Math.abs(stood.x + stood.w / 2 - centre.x) < 6 && Math.abs(stood.y + stood.h / 2 - centre.y) < 6, `${Math.round(stood.x + stood.w / 2 - centre.x)}, ${Math.round(stood.y + stood.h / 2 - centre.y)}`);
  check('the angle readout goes away afterwards', (await page.$('[data-selection-angle]')) === null);

  // One step undone, and it lies down again.
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  await page.waitForSelector('[data-selection-box]', { timeout: 2_000 }).catch(() => {});
  const back = await box().catch(() => null);
  check('undo puts it back with one step', back !== null && back.w > back.h * 3, back ? `${Math.round(back.w)}x${Math.round(back.h)}` : 'selection gone');

  // The buttons in the toolbar.
  await page.click('[data-selection-turn="right"]');
  const right = await box();
  check('the quarter-turn button stands it up', right.h > right.w * 3, `${Math.round(right.w)}x${Math.round(right.h)}`);
  await page.click('[data-selection-turn="left"]');
  const left = await box();
  check('and the other one lays it down again', left.w > left.h * 3, `${Math.round(left.w)}x${Math.round(left.h)}`);

  // Near enough to level, it sticks; a little past, it does not.
  const h2 = await page.$eval('[data-selection-rotate]', (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const c2 = { x: left.x + left.w / 2, y: left.y + left.h / 2 };
  const r2 = c2.y - h2.y;
  const near = (deg) => {
    const a = -Math.PI / 2 + (deg * Math.PI) / 180;
    return [[h2.x, h2.y], [c2.x + r2 * Math.cos(a), c2.y + r2 * Math.sin(a)]];
  };
  await page.evaluate(([pts]) => window.__pen.drag('[data-selection-rotate]', pts), [near(2)]);
  const sticky = await box();
  check('a turn of two degrees sticks at level', sticky.h < left.h + 2, `${Math.round(left.h)} -> ${Math.round(sticky.h)}`);

  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * Zooming with the toolbar's buttons.
 *
 * Reported from a tablet: in the two-page view, zooming out kept sliding the pages to
 * one side and zooming in kept sliding them back. The buttons changed the page size
 * and left the scroll offset alone, so whatever was at that offset was soon
 * somewhere else. The point at the centre of the view has to stay there.
 */
async function checkZoomAnchor(browser) {
  console.log('zoom anchoring, 1280x800:');
  const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openDocument(page);
  await page.waitForSelector('[data-viewer]', { timeout: 10_000 });
  await page.click('[aria-label="Page arranger"]');
  for (let i = 0; i < 3; i++) await page.click('text=Add after');
  await page.click('[aria-label="Page arranger"]');
  await page.waitForTimeout(300);

  // Which page, and where on it, is at the centre of the viewer.
  const centre = () =>
    page.evaluate(() => {
      const viewer = document.querySelector('[data-viewer]').getBoundingClientRect();
      const cx = viewer.left + viewer.width / 2;
      const cy = viewer.top + viewer.height / 2;
      const zoom = parseFloat(document.querySelector('[data-zoom]').textContent) / 100;
      const pages = [...document.querySelectorAll('[data-page-index]')].map((p) => ({ i: p.getAttribute('data-page-index'), r: p.getBoundingClientRect() }));
      const distance = (r) => Math.hypot(Math.max(r.left - cx, 0, cx - r.right), Math.max(r.top - cy, 0, cy - r.bottom));
      const nearest = pages.reduce((a, b) => (distance(a.r) <= distance(b.r) ? a : b));
      return { page: nearest.i, x: Math.round((cx - nearest.r.left) / zoom), y: Math.round((cy - nearest.r.top) / zoom) };
    });
  const step = async (label) => {
    await page.click(`[aria-label="${label}"]`);
    await page.waitForTimeout(220);
  };

  for (const mode of ['vertical-continuous', 'horizontal-continuous']) {
    for (let i = 0; i < 3 && (await page.getAttribute('[data-viewer]', 'data-view-mode')) !== mode; i++) {
      await page.click('[data-view-mode-toggle]');
      await page.waitForTimeout(200);
    }
    // Start in the middle of the second page, so there is room to slide either way.
    await page.evaluate(() => {
      const viewer = document.querySelector('[data-viewer]');
      const v = viewer.getBoundingClientRect();
      const p = document.querySelector('[data-page-index="1"]').getBoundingClientRect();
      viewer.scrollLeft += p.left + p.width / 2 - (v.left + v.width / 2);
      viewer.scrollTop += p.top + p.height / 2 - (v.top + v.height / 2);
    });
    await page.waitForTimeout(250);
    const start = await centre();
    const seen = [];
    for (const label of ['Zoom out', 'Zoom out', 'Zoom out', 'Zoom in', 'Zoom in', 'Zoom in', 'Zoom in', 'Zoom out']) {
      await step(label);
      seen.push(await centre());
    }
    const worst = Math.max(...seen.map((c) => (c.page === start.page ? Math.max(Math.abs(c.x - start.x), Math.abs(c.y - start.y)) : 9999)));
    check(`${mode}: the point at the centre stays there through zoom steps out and in`, worst <= 6, `start ${JSON.stringify(start)}, furthest drift ${worst}`);
    const back = seen[seen.length - 1];
    check(`${mode}: and a step out and back leaves it where it began`, back.page === start.page && Math.abs(back.x - start.x) <= 3 && Math.abs(back.y - start.y) <= 3, JSON.stringify(back));
  }
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

/**
 * Typing like a word processor: a new text box takes the keyboard straight away; Word's and Docs' shortcuts
 * format what is typed (bold, italic, subscript, headings, lists, a checklist from "[] "); the format bar acts on
 * a selection; Undo takes a burst of typing back as one; the word count, the count dialog and the shortcuts
 * sheet answer their keys; and the note's title takes no pen handwriting.
 */
async function checkTyping(browser) {
  console.log('typing in a text box, 1280x800:');
  const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openDocument(page);
  check('the title takes no pen handwriting', (await page.$eval('[data-title]', (e) => getComputedStyle(e).touchAction)) === 'none');
  await page.click('[data-insert-trigger]');
  await page.click('[data-insert-text]');
  await page.waitForSelector('[data-text-content]', { timeout: 10_000 });
  await page.waitForFunction(() => document.activeElement?.hasAttribute('data-text-content'), null, { timeout: 5_000 }).catch(() => {});
  check('a new text box takes the keyboard straight away', await page.evaluate(() => document.activeElement?.hasAttribute('data-text-content')));
  check('the format bar is there', (await page.$('[data-format-bar]')) !== null);

  await page.keyboard.type('# Plan');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Water is H');
  await page.keyboard.press('Control+,');
  await page.keyboard.type('2');
  await page.keyboard.press('Control+,');
  await page.keyboard.type('O and ');
  await page.keyboard.press('Control+b');
  await page.keyboard.type('bold');
  await page.keyboard.press('Control+b');
  await page.keyboard.press('Enter');
  await page.keyboard.type('1. first');
  await page.keyboard.press('Enter');
  await page.keyboard.type('second');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('inner');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('[] task');
  const dom = () =>
    page.$eval('[data-text-content]', (el) => ({
      blocks: [...el.children].map((p) => ({ kind: p.dataset.rtKind ?? 'p', list: p.dataset.list ?? null, marker: p.dataset.marker ?? null, text: p.textContent })),
      bold: [...el.querySelectorAll('strong')].map((b) => b.textContent),
      sub: [...el.querySelectorAll('sub')].map((b) => b.textContent),
    }));
  const typed = await dom();
  check('"# " makes a heading', typed.blocks[0]?.kind === 'h1' && typed.blocks[0]?.text === 'Plan', JSON.stringify(typed.blocks[0]));
  check('Ctrl+B and Ctrl+, make bold and subscript', typed.bold.includes('bold') && typed.sub.includes('2'), JSON.stringify(typed));
  check('"1. " numbers a list, Tab makes a sub-list', JSON.stringify(typed.blocks.slice(2, 5).map((b) => b.marker)) === JSON.stringify(['1.', '2.', 'a.']), JSON.stringify(typed.blocks));
  check('Enter on an empty item ends the list, and "[] " starts a checklist', typed.blocks[5]?.list === 'check' && typed.blocks[5]?.text === 'task', JSON.stringify(typed.blocks));
  const words = await page.textContent('[data-word-count-button]');
  check('the format bar counts the words', /^\s*10 words\s*$/.test(words ?? ''), words);

  // The format bar on a selection: select "task" and make it italic and red.
  await page.keyboard.press('Shift+Home');
  await page.waitForFunction(() => /1 of 10 words/.test(document.querySelector('[data-word-count-button]')?.textContent ?? ''), null, { timeout: 2_000 }).catch(() => {});
  check('a selection is counted as part of the whole', /1 of 10 words/.test((await page.textContent('[data-word-count-button]')) ?? ''), await page.textContent('[data-word-count-button]'));
  await page.click('[data-format-toggle="italic"]');
  await page.click('[data-format-color-open]');
  await page.click('[data-format-swatch="#dc2626"]');
  const styled = await page.$eval('[data-text-content]', (el) => {
    const em = el.querySelector('em');
    const red = [...el.querySelectorAll('span')].find((s) => s.style.color === 'rgb(220, 38, 38)');
    return { em: em?.textContent, red: red?.textContent, focused: document.activeElement === el };
  });
  check('the format bar formats the selection', styled.em === 'task' && styled.red === 'task', JSON.stringify(styled));
  check('and the caret stays in the text', styled.focused);

  // Undo: the colour, then the italic, then the burst of typing before.
  await page.keyboard.press('End');
  await page.keyboard.type(' more');
  await page.waitForTimeout(1100);
  await page.keyboard.type(' again');
  await page.keyboard.press('Control+z');
  const undone = await page.$eval('[data-text-content]', (el) => el.textContent);
  check('Ctrl+Z takes back the last burst of typing as one', undone.endsWith('task more'), undone);

  // Keys for the count and the shortcuts.
  await page.keyboard.press('Control+Shift+G');
  const counted = await page.waitForSelector('[data-word-count]', { timeout: 3_000 }).then(() => true, () => false);
  check('Ctrl+Shift+G shows the word count', counted);
  if (counted) {
    const n = await page.textContent('[data-word-count-section="note"] [data-count="Words"]');
    check('which counts the note\'s words', n === '11', n);
    await page.keyboard.press('Escape');
  }
  await page.keyboard.press('Control+/');
  const sheet = await page.waitForSelector('[data-shortcut-sheet]', { timeout: 3_000 }).then(() => true, () => false);
  check('Ctrl+/ lists the typing shortcuts', sheet && (await page.$$('[data-shortcut-group]')).length >= 5);
  if (sheet) await page.keyboard.press('Escape');

  // Selected but not being typed in: the format bar formats the whole box.
  await page.keyboard.press('Escape');
  await page.click('[data-format-toggle="underline"]');
  const underlined = await page.$eval('[data-text-content]', (el) => [...el.querySelectorAll('u')].map((u) => u.textContent).join(''));
  check('with the box selected, a format applies to all of it', underlined.includes('Plan') && underlined.includes('task'), underlined);
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * Typing on the page, as in a word processor: a new typed document has the caret in its page; text that does not
 * fit goes on to a new page, mid-paragraph if it has to, with the caret following; Ctrl+Enter starts a page;
 * Backspace at the top of it takes the break away and the text comes back; and Undo puts it all back.
 */
async function checkPageText(browser) {
  console.log('typing on the page, 1280x800:');
  const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-new-typed-document]', { timeout: 20_000 });
  await page.click('[data-new-typed-document]');
  await page.waitForSelector('[data-text-flow] [data-text-content]', { timeout: 20_000 });
  await page.waitForFunction(() => document.activeElement?.closest('[data-text-flow]') !== null, null, { timeout: 5_000 }).catch(() => {});
  check('a new typed document has the caret on its page', await page.evaluate(() => document.activeElement?.closest('[data-text-flow]') !== null));
  const state = () =>
    page.evaluate(() => {
      const pages = [...document.querySelectorAll('[data-page-index]')];
      const caretPage = document.activeElement?.closest('[data-page-index]');
      return { pages: pages.length, caretPage: caretPage ? Number(caretPage.getAttribute('data-page-index')) : -1 };
    });
  const paragraph = 'The quick brown fox jumps over the lazy dog and keeps on running through the field. '.repeat(3).trim();
  for (let i = 0; i < 14; i++) {
    await page.keyboard.insertText(paragraph);
    await page.keyboard.press('Enter');
  }
  await page.keyboard.type('The end.');
  await page.waitForTimeout(300);
  const full = await state();
  check('text that does not fit goes on to a new page', full.pages === 2, JSON.stringify(full));
  check('and the caret goes with it', full.caretPage === 1, JSON.stringify(full));
  const second = await page.$eval('[data-page-index="1"] [data-text-content]', (el) => el.firstElementChild?.textContent ?? '');
  check('a paragraph is split between the pages where its lines break', second.length > 0 && !paragraph.startsWith(second.slice(0, 20)), second.slice(0, 40));

  await page.keyboard.press('Control+Enter');
  await page.keyboard.type('Chapter two');
  await page.waitForTimeout(300);
  const broken = await state();
  check('Ctrl+Enter starts a new page', broken.pages === 3 && broken.caretPage === 2, JSON.stringify(broken));
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
  const joined = await state();
  check('Backspace at its top takes the break away, and the text comes back', joined.pages === 2 && joined.caretPage === 1, JSON.stringify(joined));
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  check('Undo puts the page back', (await state()).pages === 3, JSON.stringify(await state()));
  const count = await page.textContent('[data-word-count-button]');
  // 14 paragraphs of 48 words and "The end." ("Chapter two" went with the Undo, typed in the same breath).
  check('the word count is the whole text, every page of it', /^\s*674 words/.test(count ?? ''), count);
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * Starting with Windows and the tray, with the shell faked: the settings show the section only where the shell has it,
 * each switch sends the settings it should ("in the tray" only once "open when Windows starts" is on), and the tray's
 * Quit keeps unsaved work in the draft before it asks the shell to quit.
 */
async function checkBackgroundSettings(browser) {
  console.log('starting with Windows and the tray, 1280x800 (desktop shell faked):');
  const seedCtx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  const seedPage = await seedCtx.newPage();
  await openDocument(seedPage);
  const blank = await seedPage.evaluate(() => localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith('notes.library.doc.'))));
  await seedCtx.close();
  const contents = blank;

  const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  await ctx.addInitScript(({ contents }) => {
    const PATH = '/lib/Tray.notex';
    window.__calls = [];
    window.__callbacks = {};
    window.__listeners = [];
    let next = 1;
    let status = { supported: true, openAtLogin: false, startInTray: false, closeToTray: false };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
      transformCallback: (cb) => {
        const id = next++;
        window.__callbacks[id] = cb;
        return id;
      },
      unregisterCallback: () => {},
      invoke: async (cmd, args) => {
        window.__calls.push({ cmd, args: cmd === 'save_draft' ? null : args });
        switch (cmd) {
          case 'background_settings': return status;
          case 'set_background_settings': status = { supported: true, ...args.settings }; return status;
          case 'plugin:event|listen': window.__listeners.push({ event: args.event, handler: args.handler }); return next++;
          case 'list_library': return { path: '/lib', relativePath: '', parentPath: null, entries: [] };
          case 'create_library_document': return PATH;
          case 'open_document': return { path: PATH, contents, info: { path: PATH, bytes: contents.length, modifiedMs: 1 } };
          case 'ink_recognizers': return { names: [] };
          case 'sync_status':
          case 'sync_now': return { phase: 'offline', provider: 'Not connected', pending: 0, conflicts: [], lastSyncedMs: 0, message: null };
          case 'list_recent': return [];
          default: return null;
        }
      },
    };
    window.__emit = (event) => {
      for (const l of window.__listeners.filter((x) => x.event === event)) window.__callbacks[l.handler]?.({ event, id: 1, payload: null });
    };
  }, { contents });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openDocument(page);
  await page.waitForSelector('[data-palette-settings-trigger]', { timeout: 10_000 });
  const sets = () => page.evaluate(() => window.__calls.filter((c) => c.cmd === 'set_background_settings').map((c) => c.args.settings));

  await page.click('[data-palette-settings-trigger]');
  const shown = await page.waitForSelector('[data-open-at-login]', { timeout: 5_000 }).then(() => true, () => false);
  check('the settings offer starting with Windows and the tray', shown);
  check('"in the tray" waits for "open when Windows starts"', await page.$eval('[data-start-in-tray]', (e) => e.disabled));
  await page.click('[data-open-at-login]');
  await page.waitForFunction(() => window.__calls.some((c) => c.cmd === 'set_background_settings'), null, { timeout: 3_000 }).catch(() => {});
  check('turning it on asks the shell to open at login', JSON.stringify((await sets())[0]) === JSON.stringify({ openAtLogin: true, startInTray: false, closeToTray: false }), JSON.stringify(await sets()));
  await page.waitForFunction(() => !document.querySelector('[data-start-in-tray]').disabled, null, { timeout: 3_000 }).catch(() => {});
  await page.click('[data-start-in-tray]');
  await page.waitForFunction(() => window.__calls.filter((c) => c.cmd === 'set_background_settings').length === 2, null, { timeout: 3_000 }).catch(() => {});
  check('and then to start in the tray', (await sets())[1]?.startInTray === true && (await sets())[1]?.openAtLogin === true, JSON.stringify(await sets()));
  await page.click('[data-close-to-tray]');
  await page.waitForFunction(() => window.__calls.filter((c) => c.cmd === 'set_background_settings').length === 3, null, { timeout: 3_000 }).catch(() => {});
  check('"keep running in the tray" is its own switch', JSON.stringify((await sets())[2]) === JSON.stringify({ openAtLogin: true, startInTray: true, closeToTray: true }), JSON.stringify(await sets()));
  await page.keyboard.press('Escape');

  // The tray's Quit, with a change not yet saved.
  await page.fill('[data-title]', 'Changed before quitting');
  const listening = await page.waitForFunction(() => window.__listeners.some((l) => l.event === 'notex-quit-requested'), null, { timeout: 5_000 }).then(() => true, () => false);
  check('the page listens for the tray\'s Quit', listening);
  await page.evaluate(() => window.__emit('notex-quit-requested'));
  await page.waitForFunction(() => window.__calls.some((c) => c.cmd === 'quit_app'), null, { timeout: 5_000 }).catch(() => {});
  const order = await page.evaluate(() => window.__calls.map((c) => c.cmd).filter((c) => c === 'save_draft' || c === 'quit_app'));
  check('Quit keeps unsaved work in the draft, then quits', JSON.stringify(order.slice(-2)) === JSON.stringify(['save_draft', 'quit_app']), JSON.stringify(order));
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * A touchpad pinch reaches the page as Ctrl + wheel events, not touches: it zooms the note about the pointer —
 * previewed while the fingers move, committed when they stop, with the page point under the pointer kept where it
 * was — and draws nothing. Ctrl + a mouse wheel notch zooms by a sensible step; a plain wheel still scrolls. The
 * reading pane zooms the same way.
 */
async function checkTouchpadPinch(browser) {
  console.log('touchpad pinch zoom, 1280x800:');
  const { ctx, page, errors, cx, cy } = await openPenDocument(browser);
  const zoomText = () => page.$eval('[data-zoom]', (e) => e.textContent.trim());
  // Where (cx, cy) is on the first page, as fractions of it.
  const pagePoint = () =>
    page.evaluate(([x, y]) => {
      const r = document.querySelector('[data-page-index="0"]').getBoundingClientRect();
      return { fx: (x - r.left) / r.width, fy: (y - r.top) / r.height, width: r.width };
    }, [cx, cy]);
  const wheel = (selector, x, y, deltaY, ctrlKey, times = 1) =>
    page.evaluate(
      ({ selector, x, y, deltaY, ctrlKey, times }) => {
        const target = document.elementFromPoint(x, y)?.closest(selector) ? document.elementFromPoint(x, y) : document.querySelector(selector);
        for (let i = 0; i < times; i++) {
          target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaY, deltaMode: 0, ctrlKey }));
        }
      },
      { selector, x, y, deltaY, ctrlKey, times },
    );
  const inkBefore = await page.evaluate(() => window.__pen.ink());
  const before = await pagePoint();
  check('the note starts at 100%', (await zoomText()) === '100%', await zoomText());

  // Fingers spreading: five steps of a pinch that ends at e^0.5 ≈ 165%.
  await wheel('[data-viewer]', cx, cy, -10, true, 5);
  const previewing = await page.$eval('[data-viewer-content]', (e) => e.style.transform);
  check('while the fingers move, the zoom is previewed', /scale\(1\.6/.test(previewing), previewing);
  await page.waitForFunction(() => document.querySelector('[data-zoom]')?.textContent.trim() !== '100%', null, { timeout: 2_000 }).catch(() => {});
  await page.waitForTimeout(150);
  check('spreading two fingers on the touchpad zooms in', (await zoomText()) === '165%', await zoomText());
  check('and the preview is put away', (await page.$eval('[data-viewer-content]', (e) => e.style.transform)) === '');
  const after = await pagePoint();
  check(
    'the point under the pointer stays under it',
    Math.abs(after.fx - before.fx) < 0.01 && Math.abs(after.fy - before.fy) < 0.01 && after.width > before.width * 1.5,
    JSON.stringify({ before, after }),
  );
  check('a pinch draws nothing', (await page.evaluate(() => window.__pen.ink())) === inkBefore);

  // Pinching back in.
  await wheel('[data-viewer]', cx, cy, 10, true, 5);
  await page.waitForFunction(() => document.querySelector('[data-zoom]')?.textContent.trim() === '100%', null, { timeout: 2_000 }).catch(() => {});
  check('pinching the fingers together zooms out again', (await zoomText()) === '100%', await zoomText());

  // A mouse wheel notch with Ctrl: one zoom step (10 % unless the settings say otherwise), not 2.7×.
  await wheel('[data-viewer]', cx, cy, -100, true);
  await page.waitForFunction(() => document.querySelector('[data-zoom]')?.textContent.trim() !== '100%', null, { timeout: 2_000 }).catch(() => {});
  check('Ctrl + a mouse wheel notch zooms by one step', (await zoomText()) === '110%', await zoomText());

  // The zoom settings: speed, threshold and step, each taking effect.
  const setSlider = (selector, value) =>
    page.evaluate(([selector, value]) => {
      const el = document.querySelector(selector);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(value));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, [selector, value]);
  const resetZoom = async () => {
    await page.click('[data-zoom]');
    await page.waitForFunction(() => document.querySelector('[data-zoom]')?.textContent.trim() === '100%', null, { timeout: 2_000 }).catch(() => {});
  };
  const settle = () => page.waitForTimeout(400);
  await page.click('[data-palette-settings-trigger]');
  await page.waitForSelector('[data-zoom-pinch-speed]', { timeout: 5_000 });
  check('the settings have zoom settings', (await page.$('[data-zoom-pinch-threshold]')) !== null && (await page.$('[data-zoom-step]')) !== null);
  check('and, in a browser, nothing about starting with Windows', (await page.$('[data-open-at-login]')) === null);
  await setSlider('[data-zoom-pinch-speed]', 2);
  await setSlider('[data-zoom-step]', 25);
  await page.keyboard.press('Escape');
  await resetZoom();
  await wheel('[data-viewer]', cx, cy, -10, true, 2);
  await settle();
  check('at pinch speed 2×, the same pinch zooms twice as far (in logs)', (await zoomText()) === '149%', await zoomText());
  await resetZoom();
  await page.click('[aria-label="Zoom in"]');
  check('with a 25 % step, + zooms by 25 %', (await zoomText()) === '125%', await zoomText());
  await wheel('[data-viewer]', cx, cy, -100, true);
  await settle();
  check('and so does a Ctrl + mouse wheel notch', (await zoomText()) === '150%', await zoomText());
  await page.click('[data-palette-settings-trigger]');
  await page.waitForSelector('[data-zoom-pinch-threshold]', { timeout: 5_000 });
  await setSlider('[data-zoom-pinch-speed]', 1);
  await setSlider('[data-zoom-pinch-threshold]', 0.2);
  await page.keyboard.press('Escape');
  await resetZoom();
  await wheel('[data-viewer]', cx, cy, -5, true, 3);
  await settle();
  check('a pinch inside the threshold does not zoom', (await zoomText()) === '100%', await zoomText());
  await wheel('[data-viewer]', cx, cy, -10, true, 4);
  await settle();
  check('past it, the zoom follows from where it is, without a jump', (await zoomText()) === '124%', await zoomText());
  await page.click('[data-palette-settings-trigger]');
  await page.waitForSelector('[data-zoom-reset]', { timeout: 5_000 });
  await page.click('[data-zoom-reset]');
  check('Reset zoom puts them back', (await page.$eval('[data-zoom-step]', (e) => e.value)) === '10' && (await page.$eval('[data-zoom-pinch-threshold]', (e) => e.value)) === '0');
  await page.keyboard.press('Escape');

  // A plain wheel is still a scroll.
  const zoomed = await zoomText();
  const top = await page.$eval('[data-viewer]', (e) => e.scrollTop);
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(200);
  check('a plain wheel still scrolls, and does not zoom', (await page.$eval('[data-viewer]', (e) => e.scrollTop)) > top && (await zoomText()) === zoomed);

  // The reading pane: drop a PDF on a note with writing on it (so it opens in a tab), show it beside, pinch over it.
  await page.evaluate(() => document.querySelector('[data-viewer]').scrollTo(0, 0));
  await page.evaluate(([x, y]) => window.__pen.stroke([[x, y], [x + 60, y + 10], [x + 120, y]], 1), [cx - 60, cy]);
  const t = await page.evaluateHandle(({ bytes }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], 'Reader.pdf', { type: 'application/pdf' }));
    return transfer;
  }, { bytes: tinyPdf(2, 'Reader') });
  await page.dispatchEvent('[data-page-stage]', 'dragover', { dataTransfer: t });
  await page.dispatchEvent('[data-page-stage]', 'drop', { dataTransfer: t });
  await page.waitForSelector('[data-tab-split], [data-reference-pane]', { timeout: 15_000 }).catch(() => {});
  if (!(await page.$('[data-reference-pane]'))) await page.click('[data-tab-split]').catch(() => {});
  const pane = await page.waitForSelector('[data-reference-scroll] [data-reference-page-frame]', { timeout: 10_000 }).then(() => true, () => false);
  check('a PDF can be shown in the reading pane', pane);
  if (pane) {
    const paneWidth = () => page.$eval('[data-reference-scroll] [data-reference-page-frame]', (e) => e.getBoundingClientRect().width);
    const box = await page.$eval('[data-reference-scroll]', (e) => e.getBoundingClientRect().toJSON());
    const w0 = await paneWidth();
    const noteZoom = await zoomText();
    await wheel('[data-reference-scroll]', box.x + box.width / 2, box.y + 200, -10, true, 4);
    await page.waitForTimeout(250);
    const w1 = await paneWidth();
    check('a touchpad pinch over the reading pane zooms the pane', w1 > w0 * 1.3, `${Math.round(w0)} → ${Math.round(w1)} px`);
    check('and leaves the note as it was', (await zoomText()) === noteZoom, await zoomText());
  }
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * Saving sends the note to the shell as bytes — the IPC body, with the path in a percent-encoded header — not as a
 * JSON string to be escaped and parsed again, and what arrives is the whole note: its writing and the files embedded
 * in it. The autosaved draft goes the same way.
 */
async function checkSaveAsBytes(browser) {
  console.log('saving as bytes, 1280x800 (desktop shell faked):');
  const seedCtx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  const seedPage = await seedCtx.newPage();
  await openDocument(seedPage);
  const blank = await seedPage.evaluate(() => localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith('notes.library.doc.'))));
  await seedCtx.close();
  const envelope = JSON.parse(blank);
  envelope.document.title = 'Übung 3';
  envelope.document.recordings = [{ id: 'rec_1', startedAt: '2026-10-03T09:00:00.000Z', duration: 1, mime: 'audio/webm', data: 'AAECAwT/', marks: [] }];
  const contents = JSON.stringify(envelope);

  const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  await ctx.addInitScript(({ contents }) => {
    const PATH = '/lib/Übung 3 – notes.notex';
    window.__writes = [];
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (cmd, args, options) => {
        if (cmd === 'save_document' || cmd === 'save_draft') {
          const bytes = args instanceof Uint8Array;
          window.__writes.push({ cmd, bytes, path: options?.headers?.['x-path'] ?? null, text: bytes ? new TextDecoder().decode(args) : null });
          return { path: PATH, bytes: bytes ? args.byteLength : 0, modifiedMs: 1 };
        }
        switch (cmd) {
          case 'list_library': return { path: '/lib', relativePath: '', parentPath: null, entries: [] };
          case 'create_library_document': return PATH;
          case 'open_document': return { path: PATH, contents, info: { path: PATH, bytes: contents.length, modifiedMs: 1 } };
          case 'ink_recognizers': return { names: [] };
          case 'sync_status':
          case 'sync_now': return { phase: 'offline', provider: 'Not connected', pending: 0, conflicts: [], lastSyncedMs: 0, message: null };
          case 'list_recent': return [];
          default: return null;
        }
      },
    };
  }, { contents });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openDocument(page);
  await page.waitForFunction(() => document.querySelector('[data-title]')?.value === 'Übung 3', null, { timeout: 10_000 });
  await page.waitForSelector('[data-layer="live"]', { state: 'attached' });
  const stroke = (y) =>
    page.evaluate(async (y) => {
      const c = document.querySelector('[data-layer="live"]');
      const r = c.getBoundingClientRect();
      const fire = (type, x, b) => c.dispatchEvent(new PointerEvent(type, { pointerType: 'pen', pointerId: 7, isPrimary: true, bubbles: true, cancelable: true, clientX: r.x + x, clientY: r.y + y, buttons: b, button: type === 'pointermove' ? -1 : 0, pressure: b ? 0.5 : 0 }));
      fire('pointerdown', 100, 1);
      for (let i = 1; i < 20; i++) {
        fire('pointermove', 100 + i * 10, 1);
        await new Promise((res) => setTimeout(res, 6));
      }
      fire('pointerup', 300, 0);
    }, y);
  const writes = (cmd) => page.evaluate((cmd) => window.__writes.filter((w) => w.cmd === cmd), cmd);

  await stroke(200);
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => window.__writes.some((w) => w.cmd === 'save_document'), null, { timeout: 5_000 }).catch(() => {});
  const [saved] = await writes('save_document');
  check('Save sends the note as bytes', saved?.bytes === true, JSON.stringify(saved && { bytes: saved.bytes, path: saved.path }));
  check('with its path in the header, percent-encoded', saved?.path === encodeURIComponent('/lib/Übung 3 – notes.notex'), saved?.path);
  let file = null;
  try { file = JSON.parse(saved?.text ?? ''); } catch { /* checked below */ }
  check('and the bytes are the whole note, as the file has it', file?.format === 'notex' && file.document.title === 'Übung 3' && file.document.pages[0].strokes.length === 1, saved?.text?.slice(0, 120));
  check('the recording embedded in it written back unchanged', file?.document.recordings?.[0]?.data === 'AAECAwT/', JSON.stringify(file?.document.recordings?.[0]?.data));

  await stroke(300);
  await page.waitForFunction(() => window.__writes.some((w) => w.cmd === 'save_draft'), null, { timeout: 10_000 }).catch(() => {});
  const [draft] = await writes('save_draft');
  let draftFile = null;
  try { draftFile = JSON.parse(draft?.text ?? ''); } catch { /* checked below */ }
  check('the autosaved draft goes as bytes too, with the new stroke', draft?.bytes === true && draftFile?.document.pages[0].strokes.length === 2, JSON.stringify(draft && { bytes: draft.bytes, strokes: draftFile?.document.pages[0].strokes.length }));
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * Recording sound while writing, and playing it back with the writing: strokes written while it records are marked
 * with when they were begun; the player fades what was not yet written at its position; tapping writing plays from
 * when it was written, without drawing; and a recording can be deleted. The microphone is Chromium's fake one.
 */
async function checkAudioRecording(browser) {
  console.log('recording sound with the writing, 1280x800 (fake microphone):');
  const { ctx, page, errors, cx, cy } = await openPenDocument(browser, undefined, { permissions: ['microphone'] });
  page.on('dialog', (d) => void d.accept());
  const row = (y) => Array.from({ length: 30 }, (_, i) => [cx - 120 + i * 8, y]);
  // Ink as the pen draws it, and ink at a fifth of that, on the page's committed layer.
  const inkAlpha = () =>
    page.$eval('[data-layer="committed"]', (c) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let strong = 0, faint = 0;
      for (let i = 3; i < d.length; i += 4) {
        if (d[i] > 90) strong++;
        else if (d[i] > 5) faint++;
      }
      return { strong, faint };
    });
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

  await page.evaluate(([pts]) => window.__pen.stroke(pts, 1), [row(cy)]);
  check('there is no Recordings button before anything is recorded', (await page.$('[data-recordings-toggle]')) === null);
  await page.click('[data-record-toggle]');
  const started = await page.waitForFunction(() => document.querySelector('[data-recording-elapsed]')?.textContent?.startsWith('Recording'), null, { timeout: 8_000 }).then(() => true, () => false);
  check('Record starts recording, and says so', started, await page.$eval('[data-recording-bar]', (el) => el.textContent).catch(() => 'no bar'));
  if (!started) {
    check('no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
    return;
  }
  check('the Record button shows it is on', (await page.getAttribute('[data-record-toggle]', 'aria-pressed')) === 'true');
  await page.waitForTimeout(1200);
  await page.evaluate(([pts]) => window.__pen.stroke(pts, 1), [row(cy + 60)]);
  await page.waitForTimeout(1600);
  await page.evaluate(([pts]) => window.__pen.stroke(pts, 1), [row(cy + 120)]);
  await page.waitForTimeout(600);
  const elapsed = await page.$eval('[data-recording-elapsed]', (el) => el.textContent);
  check('the time recorded counts up', /Recording 0:0[2-4]/.test(elapsed), elapsed);
  const allInk = await inkAlpha();

  await page.click('[data-recording-stop]');
  const stopped = await page.waitForSelector('[data-recordings-toggle]', { timeout: 8_000 }).then(() => true, () => false);
  check('Stop puts the recording in the note', stopped);
  check('the recording bar goes', (await page.$('[data-recording-bar]')) === null);
  const notice = await page.evaluate(() => [...document.querySelectorAll('[data-notice], [data-notice-toast]')].map((el) => el.textContent).join(' | '));
  check('and it says the recording is to be saved with the note', /Recording of 0:0\d added/.test(notice ?? ''), notice);

  await page.click('[data-recordings-toggle]');
  await page.waitForSelector('[data-player]', { timeout: 5_000 });
  check('opening the player clears the notice, which would cover it on a narrow screen', (await page.$('[data-notice], [data-notice-toast]')) === null);
  const time = () => page.$eval('[data-player-time]', (el) => el.textContent);
  const length = (await time()).split('/')[1]?.trim() ?? '';
  check('the player shows the recording\'s length', /^0:0[3-4]$/.test(length), await time());
  await frames();
  const atStart = await inkAlpha();
  check('at the start, the writing done while recording is faded', atStart.strong < allInk.strong * 0.5 && atStart.faint > 0, `${atStart.strong} strong of ${allInk.strong}, ${atStart.faint} faint`);
  check('and the writing from before it is not', atStart.strong > allInk.strong * 0.2, `${atStart.strong} strong of ${allInk.strong}`);

  const seekTo = (t) =>
    page.evaluate((value) => {
      const el = document.querySelector('[data-player-seek]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(value));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, t);
  await seekTo(2.2);
  await frames();
  const middle = await inkAlpha();
  check('part way through, what was written by then is shown in full', middle.strong > atStart.strong * 1.5 && middle.strong < allInk.strong * 0.9, `${middle.strong} strong, start ${atStart.strong}, all ${allInk.strong}`);
  await seekTo(10);
  await frames();
  const end = await inkAlpha();
  check('at the end, all of it', Math.abs(end.strong - allInk.strong) < allInk.strong * 0.05, `${end.strong} vs ${allInk.strong}`);

  // Tap ink: a tap on paper draws nothing; a tap on the last line plays from a little before it was written.
  await page.click('[data-player-tap]');
  await seekTo(0);
  await frames();
  const beforeTaps = await inkAlpha();
  await page.evaluate(([x, y]) => window.__pen.stroke([[x, y], [x + 1, y]], 1), [cx, cy + 260]);
  await frames();
  const afterBlankTap = await inkAlpha();
  check('with Tap ink on, the pen does not draw', afterBlankTap.strong === beforeTaps.strong && afterBlankTap.faint === beforeTaps.faint, JSON.stringify([beforeTaps, afterBlankTap]));
  await page.evaluate(([x, y]) => window.__pen.stroke([[x, y]], 1), [cx, cy]);
  const said = await page.waitForSelector('[data-player-message]', { timeout: 2_000 }).then((el) => el.textContent(), () => '');
  check('tapping writing from before the recording says it was not written during it', /Not written during this recording/.test(said), said);
  check('and does not play', (await page.getAttribute('[data-player-play]', 'aria-label')) === 'Play');
  await page.evaluate(([x, y]) => window.__pen.stroke([[x, y]], 1), [cx, cy + 120]);
  const playing = await page.waitForSelector('[data-player-play][aria-label="Pause"]', { timeout: 3_000 }).then(() => true, () => false);
  check('tapping the last line plays the recording', playing, await page.$eval('[data-player-play]', (el) => el.getAttribute('aria-label')));
  const from = await page.evaluate(() => document.querySelector('[data-player-seek]').valueAsNumber);
  check('from a little before it was written', from >= 0.8 && from <= 2.6, `at ${from.toFixed(2)} s`);
  await page.click('[data-player-play]');

  await page.click('[data-player-delete]');
  const gone = await page.waitForSelector('[data-player]', { state: 'detached', timeout: 3_000 }).then(() => true, () => false);
  check('deleting the recording closes the player', gone);
  check('and the Recordings button goes with it', (await page.$('[data-recordings-toggle]')) === null);
  await frames();
  const after = await inkAlpha();
  check('the writing stays, in full', Math.abs(after.strong - allInk.strong) < allInk.strong * 0.05, `${after.strong} vs ${allInk.strong}`);
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

const browser = await chromium.launch({
  executablePath,
  // A microphone that plays a tone, allowed without asking, and sound that may play without a tap first.
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
try {
  const checks = [
    checkPhone,
    checkSmallTablet,
    checkDesktop,
    checkCloudPanel,
    checkGoodNotesImport,
    checkFileDrop,
    checkTabs,
    checkSplit,
    checkToolbar,
    checkDocks,
    checkQuickSettings,
    checkPenButtons,
    checkLasso,
    checkLongStroke,
    checkRotate,
    checkArrange,
    checkGridSnap,
    checkAids,
    checkZoomWindow,
    checkSearch,
    checkLibrarySearch,
    checkLibraryPdfSearch,
    checkLibraryHandwritingSearch,
    checkVersionHistory,
    checkAppLock,
    checkBookmarks,
    checkLibraryOrganising,
    checkReadingDrop,
    checkContents,
    checkTextSelect,
    checkTopBarNarrow,
    checkHandwritingSearch,
    checkSnipping,
    checkDragScroll,
    checkErrorBoundary,
    checkTextToolbar,
    checkZoomAnchor,
    checkAudioRecording,
    checkSaveAsBytes,
    checkTouchpadPinch,
    checkBackgroundSettings,
    checkTyping,
    checkPageText,
  ];
  for (const run of checks) {
    if (only.length > 0 && !only.some((o) => run.name.toLowerCase().includes(o.toLowerCase()))) continue;
    await run(browser);
  }
} finally {
  await browser.close();
  if (server) {
    try { process.kill(-server.pid); } catch { /* already gone */ }
  }
}

console.log(failures === 0 ? '\nui-check: all checks passed' : `\nui-check: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
