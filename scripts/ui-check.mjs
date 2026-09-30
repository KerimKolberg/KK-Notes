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
async function openPenDocument(browser, stylus) {
  const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
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
 * The floating toolbar over a text box. It wraps to two or three rows, and anchored by
 * its top (as it was) it grew down over the text it was formatting; near the top of
 * the page it has to go underneath, and it can be pulled aside by its grip.
 */
async function checkTextToolbar(browser) {
  console.log('text box toolbar, 1280x800:');
  const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openDocument(page);
  await page.waitForSelector('[data-insert-trigger]', { timeout: 10_000 });
  await page.click('[data-insert-trigger]');
  await page.click('[data-insert-text]');
  await page.waitForSelector('[data-text-content]');
  await page.type('[data-text-content]', 'Hello there');
  const rects = () =>
    page.evaluate(() => {
      const r = (el) => { const b = el.getBoundingClientRect(); return { t: b.top, b: b.bottom, l: b.left, r: b.right }; };
      const tb = document.querySelector('[data-media-toolbar]');
      return { toolbar: r(tb), placement: tb.getAttribute('data-media-toolbar-placement'), box: r(document.querySelector('[data-media-kind="text"]')), page: r(document.querySelector('[data-page-index="0"]')) };
    });
  const overlaps = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;

  const mid = await rects();
  check('in the middle of a page the toolbar stands above the box', mid.placement === 'above' && mid.toolbar.b <= mid.box.t, `${Math.round(mid.toolbar.b)} vs ${Math.round(mid.box.t)}`);

  // Up to the top of the page by the strip above the box.
  const t = await (await page.$('[data-media-kind="text"]')).boundingBox();
  await page.mouse.move(t.x + t.width / 2, t.y - 20);
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
  await checkToolbar(browser);
  await checkDocks(browser);
  await checkQuickSettings(browser);
  await checkPenButtons(browser);
  await checkLasso(browser);
  await checkLongStroke(browser);
  await checkRotate(browser);
  await checkArrange(browser);
  await checkTextToolbar(browser);
  await checkZoomAnchor(browser);
} finally {
  await browser.close();
  if (server) {
    try { process.kill(-server.pid); } catch { /* already gone */ }
  }
}

console.log(failures === 0 ? '\nui-check: all checks passed' : `\nui-check: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
