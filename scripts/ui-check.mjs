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
  await checkGoodNotesImport(browser);
  await checkFileDrop(browser);
  await checkTabs(browser);
  await checkSplit(browser);
} finally {
  await browser.close();
  if (server) {
    try { process.kill(-server.pid); } catch { /* already gone */ }
  }
}

console.log(failures === 0 ? '\nui-check: all checks passed' : `\nui-check: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
