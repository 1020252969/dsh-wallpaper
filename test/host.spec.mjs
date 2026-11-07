/**
 * dsh-wallpaper — host half tests.
 *
 * Run: node test/host.spec.mjs
 *
 * No test framework: a fake `ctx` plus a real HTTP server covers every branch,
 * including the panel's POST endpoints and the SSRF guard. The client half is
 * covered by client.spec.mjs.
 *
 * The override store is pointed at the scratch directory via DSH_WALLPAPER_DIR
 * so a real ~/.dsh/wallpaper/settings.json can never leak into these tests.
 */

import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import {
  apply,
  name,
  inject,
  normalizeConfig,
  plainConfig,
  revisionOf,
  publicConfig,
  pickConfig,
  sniffImage,
  ipIsPrivate,
  assertPublicUrl,
  PRESETS,
  Config,
  WALLPAPER_VERSION,
  BUNDLED_DEFAULT_IMAGE,
} from '../lib/index.js';

let passed = 0;
let failed = 0;

async function test(label, body) {
  try {
    await body();
    passed += 1;
    console.log(`  ok   ${label}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${label}`);
    console.error(`       ${error.message}`);
  }
}

/** Collect the single route the host half registers, then serve it for real. */
function makeHarness(config) {
  const routes = [];
  const effects = [];
  const ctx = {
    effect(fn, label) {
      effects.push({ label, dispose: fn() });
      return () => {};
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {
          const index = routes.indexOf(route);
          if (index >= 0) routes.splice(index, 1);
        };
      },
    },
  };
  apply(ctx, config);
  return { routes, effects, ctx };
}

/** Drive the registered route with a real socket, so headers and streams are real. */
async function serve(harness, path, method = 'GET', headers = {}, body = undefined) {
  const route = harness.routes[0];
  // The host passes the FULL path to a prefix handler — the plugin slices its own
  // prefix off. Do not strip it here, or every route looks like "/".
  const server = createServer((req, res) => {
    route.handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const init = { method, headers };
    if (body !== undefined) init.body = body;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
    return { status: response.status, headers: response.headers, body: response };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const JSON_HEADERS = { 'content-type': 'application/json' };
const post = (harness, path, body) => serve(harness, `/wallpaper/api${path}`, 'POST', JSON_HEADERS, JSON.stringify(body));
const resetStore = (harness) => post(harness, '/config', { reset: true });

const scratch = await mkdtemp(join(tmpdir(), 'dsh-wallpaper-test-'));
process.env.DSH_WALLPAPER_DIR = scratch;
const picture = join(scratch, 'bg.jpg');
const NOT_AN_IMAGE = join(scratch, 'notes.txt');
await writeFile(picture, Buffer.from('not really a jpeg, but the host does not decode it'));
await writeFile(NOT_AN_IMAGE, Buffer.from('plain text'));

async function assertRejects(promise, label) {
  let threw = false;
  try {
    await promise;
  } catch {
    threw = true;
  }
  assert.ok(threw, label);
}

/* ------------------------------------------------------------------ contract */

await test('exports the cordis contract', () => {
  assert.equal(name, 'wallpaper');
  assert.deepEqual(inject, ['webServer']);
  assert.equal(typeof apply, 'function');
  assert.equal(WALLPAPER_VERSION, 3);
});

await test('exports a settings schema the live settings service can read', () => {
  assert.ok(Config && (typeof Config === 'object' || typeof Config === 'function'), 'a live settings service reads this export');
  assert.equal(plainConfig({ opacity: { get: () => 0.4 }, fill: 'contain' }).opacity, 0.4, 'volatile boxes are unwrapped');
  assert.equal(plainConfig({ opacity: { get: () => 0.4 } }).fill, undefined);
});

await test('registers one prefix route and one reversible effect', () => {
  const harness = makeHarness({ imagePath: picture });
  assert.equal(harness.routes.length, 1);
  assert.equal(harness.routes[0].kind, 'prefix');
  assert.equal(harness.routes[0].path, '/wallpaper/api');
  assert.equal(harness.effects.length, 1);
  assert.equal(harness.effects[0].label, 'wallpaper: api');
});

await test('ships four presets for the control panel', () => {
  assert.ok(Array.isArray(PRESETS));
  assert.equal(PRESETS.length, 4);
  for (const preset of PRESETS) {
    assert.equal(typeof preset.id, 'string');
    assert.equal(typeof preset.label, 'string');
    assert.equal(typeof preset.values, 'object');
  }
});

/* -------------------------------------------------------------------- config */

await test('normalizeConfig clamps every knob', () => {
  const settings = normalizeConfig({
    imagePath: '  /x/y.jpg  ',
    opacity: 2,
    blur: -3,
    panelAlpha: '0.5',
    backdropBlur: 999,
    fill: 'stretch',
    scrimColor: '#101010',
    scrimAlpha: 0,
    scrim: '  ',
  });
  assert.equal(settings.imagePath, '/x/y.jpg', 'an accidental leading space would break stat()');
  assert.equal(settings.opacity, 1, 'opacity is clamped to 1');
  assert.equal(settings.blur, 0, 'a negative blur falls back rather than going negative');
  assert.equal(settings.panelAlpha, 0.5, 'a numeric string is accepted');
  assert.equal(settings.backdropBlur, 64, 'backdrop blur is clamped to 64');
  assert.equal(settings.fill, 'cover', 'an unknown fill mode falls back');
  assert.equal(settings.scrimAlpha, 0, 'a negative scrim alpha clamps to 0');
  assert.equal(settings.scrim, 'rgba(16, 16, 16, 0)', 'the colour + alpha win over the blank legacy field');
});

await test('normalizeConfig survives a missing config', () => {
  const settings = normalizeConfig(undefined);
  assert.equal(settings.imagePath, BUNDLED_DEFAULT_IMAGE, 'an empty config falls back to the bundled picture');
  assert.equal(settings.enabled, true, 'the background is on unless explicitly turned off');
  assert.equal(settings.opacity, 1);
  assert.equal(settings.blur, 0);
  assert.equal(settings.panelAlpha, 0.35);
  assert.equal(settings.backdropBlur, 0);
  assert.equal(settings.fill, 'cover');
  assert.equal(settings.scrim, 'rgba(8, 9, 14, 0.35)');
});

await test('revisionOf changes whenever a visible knob changes', () => {
  const base = normalizeConfig({ imagePath: '/x/y.jpg' });
  const moved = { ...base, panelAlpha: 0.5 };
  assert.notEqual(revisionOf(base), revisionOf(moved));
  assert.equal(revisionOf(base), revisionOf({ ...base }), 'the same knobs must give the same revision');
});

await test('publicConfig strips the internal version stamp', () => {
  const settings = normalizeConfig({ imagePath: '/x/y.jpg' });
  const pub = publicConfig(settings);
  assert.equal(pub.version, undefined);
  assert.equal(pub.imagePath, '/x/y.jpg');
  assert.equal(pub.panelAlpha, 0.35);
});

await test('pickConfig whitelists keys and coerces the enabled flag', () => {
  const picked = pickConfig({
    panelAlpha: 0.6,
    enabled: 'false',
    fill: 'contain',
    __proto__: { polluted: true },
    evilKey: 1,
  });
  assert.deepEqual(picked, { panelAlpha: 0.6, enabled: false, fill: 'contain' });
  assert.equal(pickConfig({}).evilKey, undefined);
  assert.equal(pickConfig({ enabled: true }).enabled, true);
});

/* ---------------------------------------------------------- image + URL guards */

await test('sniffImage recognises real magic bytes and rejects junk', () => {
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
  const gif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(32)]);
  assert.equal(sniffImage(png)?.ext, '.png');
  assert.equal(sniffImage(jpg)?.ext, '.jpg');
  assert.equal(sniffImage(gif)?.ext, '.gif');
  assert.equal(sniffImage(Buffer.from('plain text')), null, 'an extension is never trusted');
  assert.equal(sniffImage(Buffer.alloc(0)), null);
});

await test('ipIsPrivate blocks the classic internal ranges', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '172.20.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fc00::1', 'fe80::1']) {
    assert.equal(ipIsPrivate(ip), true, `${ip} must be refused`);
  }
  assert.equal(ipIsPrivate('8.8.8.8'), false);
  assert.equal(ipIsPrivate('not-an-ip'), true, 'anything unparseable is refused too');
});

await test('assertPublicUrl refuses SSRF-shaped targets and accepts a plain public IP', async () => {
  await assertRejects(assertPublicUrl('http://127.0.0.1/x.png'), 'loopback');
  await assertRejects(assertPublicUrl('http://192.168.1.1/x.png'), 'LAN');
  await assertRejects(assertPublicUrl('http://[::1]/x.png'), 'IPv6 loopback');
  await assertRejects(assertPublicUrl('http://169.254.169.254/latest/meta-data'), 'cloud metadata');
  await assertRejects(assertPublicUrl('file:///etc/passwd'), 'non-http scheme');
  await assertRejects(assertPublicUrl('http://user:pass@8.8.8.8/x.png'), 'embedded credentials');
  await assertRejects(assertPublicUrl('http://8.8.8.8:8080/x.png'), 'non-default port');
  const ok = await assertPublicUrl('http://8.8.8.8/x.png');
  assert.equal(ok.hostname, '8.8.8.8', 'a public IP needs no DNS and must pass');
});

/* --------------------------------------------------------------------- routes */

await test('GET /info describes the configured image and ships the presets', async () => {
  const harness = makeHarness({ imagePath: picture, panelAlpha: 0.4, fill: 'contain', backdropBlur: 6 });
  const { status, headers, body } = await serve(harness, '/wallpaper/api/info');
  assert.equal(status, 200);
  assert.equal(headers.get('cache-control'), 'no-store');
  const info = await body.json();
  assert.equal(info.ok, true);
  assert.equal(info.contentType, 'image/jpeg');
  assert.equal(info.bytes, 50);
  assert.equal(typeof info.mtimeMs, 'number');
  assert.equal(info.version, 3);
  assert.equal(info.enabled, true);
  assert.equal(info.fill, 'contain');
  assert.equal(info.backdropBlur, 6);
  assert.equal(typeof info.revision, 'string');
  assert.ok(info.revision.length > 0, 'the client polls this to decide whether to repaint');
  assert.equal(Array.isArray(info.presets), true, 'the panel builds its preset buttons from this');
  assert.equal(info.presets.length, 4);
  assert.equal(typeof info.wallpaperDir, 'string');
});

await test('a knob change is visible on the next request, with no reload', async () => {
  const config = { imagePath: picture, panelAlpha: 0.35 };
  const harness = makeHarness(config);
  const before = await (await serve(harness, '/wallpaper/api/info')).body.json();
  config.panelAlpha = 0.6;
  const after = await (await serve(harness, '/wallpaper/api/info')).body.json();
  assert.equal(after.panelAlpha, 0.6);
  assert.notEqual(after.revision, before.revision, 'the revision must move or the client never repaints');
});

await test('GET /info reports a switched-off background as such', async () => {
  const harness = makeHarness({ imagePath: picture, enabled: false });
  const { status, body } = await serve(harness, '/wallpaper/api/info');
  assert.equal(status, 200);
  const info = await body.json();
  assert.equal(info.ok, false);
  assert.equal(info.reason, 'disabled');
  assert.equal(info.enabled, false);
});

await test('GET /info reports a missing file without throwing', async () => {
  const harness = makeHarness({ imagePath: join(scratch, 'nope.jpg') });
  const { status, body } = await serve(harness, '/wallpaper/api/info');
  assert.equal(status, 200, 'the client needs the reason, not a transport error');
  const info = await body.json();
  assert.equal(info.ok, false);
  assert.match(info.error, /ENOENT|no such file/i);
});

await test('GET /info falls back to the bundled default when nothing is configured', async () => {
  const harness = makeHarness({});
  const { status, body } = await serve(harness, '/wallpaper/api/info');
  const info = await body.json();
  assert.equal(status, 200);
  assert.equal(info.ok, true, 'a fresh install must show a wallpaper with zero config');
  assert.equal(info.imagePath, BUNDLED_DEFAULT_IMAGE);
  assert.equal(info.contentType, 'image/jpeg');
  assert.ok(info.bytes > 100000, 'the bundled jpeg is really shipped');
});

await test('BUNDLED_DEFAULT_IMAGE points at a real file in the source tree', async () => {
  const info = await stat(BUNDLED_DEFAULT_IMAGE);
  assert.ok(info.isFile());
  assert.equal(info.size, 499076);
});

await test('GET /image streams the configured file', async () => {
  const harness = makeHarness({ imagePath: picture });
  const { status, headers, body } = await serve(harness, '/wallpaper/api/image');
  assert.equal(status, 200);
  assert.equal(headers.get('content-type'), 'image/jpeg');
  assert.equal(headers.get('content-length'), '50');
  const bytes = Buffer.from(await body.arrayBuffer());
  assert.equal(bytes.length, 50);
  assert.equal(bytes.toString('utf8'), 'not really a jpeg, but the host does not decode it');
});

await test('GET /image honours If-None-Match with the same etag', async () => {
  const harness = makeHarness({ imagePath: picture });
  const first = await serve(harness, '/wallpaper/api/image');
  const etag = first.headers.get('etag');
  assert.ok(etag, 'an etag must be sent or caching cannot be validated');
  await first.body.arrayBuffer();
  const second = await serve(harness, '/wallpaper/api/image', 'GET', { 'if-none-match': etag });
  assert.equal(second.status, 304);
});

await test('GET /image 404s when the file is gone', async () => {
  const harness = makeHarness({ imagePath: join(scratch, 'nope.jpg') });
  const { status, body } = await serve(harness, '/wallpaper/api/image');
  assert.equal(status, 404);
  assert.equal((await body.json()).ok, false);
});

await test('GET /image streams the bundled default when nothing is configured', async () => {
  const harness = makeHarness({});
  const { status, headers, body } = await serve(harness, '/wallpaper/api/image');
  assert.equal(status, 200);
  assert.equal(headers.get('content-type'), 'image/jpeg');
  assert.equal(headers.get('content-length'), '499076');
  assert.equal((await body.arrayBuffer()).byteLength, 499076);
});

await test('an unknown route 404s with the route name', async () => {
  const harness = makeHarness({ imagePath: picture });
  const { status, body } = await serve(harness, '/wallpaper/api/secret');
  assert.equal(status, 404);
  assert.match((await body.json()).error, /secret/);
});

await test('the route cannot be used to read another file', async () => {
  // There is no path parameter at all: this is the whole point. A traversal
  // attempt has to land on the unknown-route branch.
  const harness = makeHarness({ imagePath: picture });
  const { status } = await serve(harness, '/wallpaper/api/..%2F..%2Fetc%2Fpasswd');
  assert.equal(status, 404);
});

await test('a non-image file is served with its real type, not mislabelled', async () => {
  const harness = makeHarness({ imagePath: NOT_AN_IMAGE });
  const { headers } = await serve(harness, '/wallpaper/api/image');
  assert.equal(headers.get('content-type'), 'application/octet-stream');
});

/* ------------------------------------------------------- panel POST endpoints */

await test('POST /config persists knobs and /info reflects them', async () => {
  const harness = makeHarness({ imagePath: picture, panelAlpha: 0.35 });
  try {
    const { status, body } = await post(harness, '/config', { panelAlpha: 0.6, backdropBlur: 8 });
    assert.equal(status, 200);
    const result = await body.json();
    assert.equal(result.ok, true);
    assert.equal(result.config.panelAlpha, 0.6);
    assert.equal(result.config.version, undefined);
    const info = await (await serve(harness, '/wallpaper/api/info')).body.json();
    assert.equal(info.panelAlpha, 0.6);
    assert.equal(info.backdropBlur, 8);
  } finally {
    await resetStore(harness);
  }
});

await test('POST /config {reset:true} restores the profile patch values', async () => {
  const harness = makeHarness({ imagePath: picture, panelAlpha: 0.35 });
  try {
    await post(harness, '/config', { panelAlpha: 0.9 });
    const { status, body } = await resetStore(harness);
    assert.equal(status, 200);
    assert.equal((await body.json()).config.panelAlpha, 0.35);
    const info = await (await serve(harness, '/wallpaper/api/info')).body.json();
    assert.equal(info.panelAlpha, 0.35);
  } finally {
    await resetStore(harness);
  }
});

await test('POST /config {useDefault:true} switches back to the bundled picture', async () => {
  const harness = makeHarness({ imagePath: picture, enabled: false });
  try {
    await post(harness, '/config', { imagePath: picture, enabled: true });
    const { status, body } = await post(harness, '/config', { useDefault: true });
    assert.equal(status, 200);
    const result = await body.json();
    assert.equal(result.ok, true);
    assert.equal(result.config.imagePath, BUNDLED_DEFAULT_IMAGE);
    assert.equal(result.config.enabled, true);
    const info = await (await serve(harness, '/wallpaper/api/info')).body.json();
    assert.equal(info.ok, true);
    assert.equal(info.imagePath, BUNDLED_DEFAULT_IMAGE);
  } finally {
    await resetStore(harness);
  }
});

await test('POST /clear turns the background off', async () => {
  const harness = makeHarness({ imagePath: picture });
  try {
    const { status, body } = await post(harness, '/clear', {});
    assert.equal(status, 200);
    assert.equal((await body.json()).config.enabled, false);
    const info = await (await serve(harness, '/wallpaper/api/info')).body.json();
    assert.equal(info.ok, false);
    assert.equal(info.reason, 'disabled');
  } finally {
    await resetStore(harness);
  }
});

await test('POST /upload saves a real PNG and points imagePath at it', async () => {
  const harness = makeHarness({ imagePath: picture });
  try {
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(48)]);
    const { status, body } = await post(harness, '/upload', { dataBase64: png.toString('base64') });
    assert.equal(status, 200);
    const result = await body.json();
    assert.equal(result.ok, true);
    assert.equal(result.bytes, png.length);
    assert.equal(result.contentType, 'image/png');
    assert.equal(result.imagePath.startsWith(scratch.replace(/\\/g, '/')), true);
    assert.equal((await stat(result.imagePath)).size, png.length, 'the bytes really landed on disk');
    const info = await (await serve(harness, '/wallpaper/api/info')).body.json();
    assert.equal(info.ok, true);
    assert.equal(info.imagePath, result.imagePath);
    assert.equal(info.enabled, true);
  } finally {
    await resetStore(harness);
  }
});

await test('POST /upload rejects a non-image and a malformed payload', async () => {
  const harness = makeHarness({ imagePath: picture });
  try {
    const junk = await post(harness, '/upload', { dataBase64: Buffer.from('hello world').toString('base64') });
    assert.equal(junk.status, 415);
    assert.equal((await junk.body.json()).ok, false);
    const empty = await post(harness, '/upload', {});
    assert.equal(empty.status, 400);
  } finally {
    await resetStore(harness);
  }
});

await test('POST /import-url refuses a private address without fetching', async () => {
  const harness = makeHarness({ imagePath: picture });
  try {
    const { status, body } = await post(harness, '/import-url', { url: 'http://127.0.0.1/x.png' });
    assert.equal(status, 400);
    assert.match((await body.json()).error, /blocked address|not allowed|http/i);
  } finally {
    await resetStore(harness);
  }
});

await test('POST /config rejects invalid json and unknown-only payloads', async () => {
  const harness = makeHarness({ imagePath: picture });
  const bad = await serve(harness, '/wallpaper/api/config', 'POST', JSON_HEADERS, '{not json');
  assert.equal(bad.status, 400);
  const empty = await post(harness, '/config', { nope: 1 });
  assert.equal(empty.status, 400);
});

/* ------------------------------------------------------------------ teardown */

await test('the effect disposes the route', () => {
  const harness = makeHarness({ imagePath: picture });
  assert.equal(harness.routes.length, 1);
  harness.effects[0].dispose();
  assert.equal(harness.routes.length, 0, 'a disposed plugin must not keep serving');
});

await rm(scratch, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
