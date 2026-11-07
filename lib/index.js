/**
 * dsh-wallpaper — host half (v3).
 *
 * Serves ONE picture behind the DSH shell and a small JSON API that the
 * browser-side control panel drives. Everything the panel changes is persisted
 * to `wallpaperDir/settings.json` (a plain "override" layered OVER the profile
 * patch row), so it survives both a plugin reload and a full host restart.
 *
 * Why an override file instead of writing cordis.patch.yml: the loader owns that
 * file, and rewriting a row from inside the plugin triggers a config-reload
 * storm. A separate file keeps the panel instant and the loader untouched.
 *
 * Security notes
 *  - /image has NO path parameter: it only ever streams the single configured
 *    file, so no directory traversal is possible.
 *  - /upload ignores the client-supplied filename entirely; the extension comes
 *    from magic-byte sniffing and the name is generated.
 *  - /import-url is guarded against obvious SSRF (private/loopback/link-local
 *    addresses, credentials, non-default ports, redirect re-checks, size caps).
 *    Residual risk: DNS rebinding (the global fetch cannot pin a resolved IP).
 */

import { createReadStream } from 'node:fs';
import { stat, readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import z from '@deepseek-ai/schemastery';

export const name = 'wallpaper';
export const inject = ['webServer'];
export const WALLPAPER_VERSION = 3;

const NAMESPACE = 'wallpaper';
const API_PREFIX = '/wallpaper/api';
const FILL_MODES = ['cover', 'contain'];
const DEFAULT_FILL = 'cover';
const DEFAULT_PANEL_ALPHA = 0.35;
const DEFAULT_SCRIM_COLOR = '#08090e';
const DEFAULT_SCRIM_ALPHA = 0.35;
const DEFAULT_SCRIM_CSS = 'rgba(8, 9, 14, 0.35)';

const DEFAULT_WALLPAPER_DIR = join(homedir(), '.dsh', 'wallpaper').replace(/\\/g, '/');

/**
 * A picture shipped INSIDE the plugin, so a fresh install has a wallpaper with
 * zero configuration. The user's own image overrides it at any time via the
 * control panel (upload / URL / "内置默认图" to come back to this one).
 * Relative to lib/index.js, so it resolves the same way in the source tree and
 * in the installed (copied, not symlinked) profile package.
 */
export const BUNDLED_DEFAULT_IMAGE = fileURLToPath(
  new URL('../assets/default-bg.jpg', import.meta.url),
).replace(/\\/g, '/');
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const URL_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 4;

const CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
};

const CONFIG_KEYS = [
  'enabled', 'imagePath', 'opacity', 'blur', 'panelAlpha',
  'backdropBlur', 'fill', 'scrimColor', 'scrimAlpha', 'scrim', 'launcherPos',
];

/** One source of truth for the preset buttons: shipped to the client on /info. */
export const PRESETS = [
  {
    id: 'clear', label: '清晰', hint: '文字优先，面板更实',
    values: { opacity: 1, blur: 0, panelAlpha: 0.55, backdropBlur: 0, scrimAlpha: 0.35, fill: 'cover' },
  },
  {
    id: 'frost', label: '磨砂', hint: '面板毛玻璃，图片轻糊',
    values: { opacity: 1, blur: 2, panelAlpha: 0.30, backdropBlur: 12, scrimAlpha: 0.30, fill: 'cover' },
  },
  {
    id: 'vivid', label: '鲜明', hint: '尽量把图片露出来',
    values: { opacity: 1, blur: 0, panelAlpha: 0.18, backdropBlur: 0, scrimAlpha: 0.22, fill: 'cover' },
  },
  {
    id: 'ambient', label: '氛围', hint: '大模糊 + 暗遮罩，只留色调',
    values: { opacity: 0.8, blur: 40, panelAlpha: 0.22, backdropBlur: 6, scrimAlpha: 0.5, fill: 'cover' },
  },
];

/** The live settings service can only persist schemas whose every field is volatile. */
function volatileField(schema) {
  return typeof schema.volatile === 'function' ? schema.volatile() : schema;
}

export const Config = z.object({
  enabled: volatileField(z.boolean().default(true).description('显示背景图；关掉即完全恢复默认外观')),
  imagePath: volatileField(z.string().default('').description('图片绝对路径，例如 C:/Users/1/.dsh/wallpaper/bg.jpg')),
  opacity: volatileField(z.number().min(0).max(1).step(0.01).default(1).description('图片自身不透明度（0–1）')),
  blur: volatileField(z.number().min(0).max(64).step(1).default(0).description('图片自身模糊，单位 px（0–64）')),
  panelAlpha: volatileField(
    z.number().min(0).max(1).step(0.01).default(DEFAULT_PANEL_ALPHA)
      .description('面板不透明度总钮（0–1）：越大越遮图。外壳两层都涂，视觉上约等于 1-(1-a)²'),
  ),
  backdropBlur: volatileField(z.number().min(0).max(64).step(1).default(0).description('毛玻璃：给面板加 backdrop-filter 模糊，单位 px（0 = 关）')),
  fill: volatileField(z.union(FILL_MODES).default(DEFAULT_FILL).description('填充方式：cover 铺满 / contain 完整')),
  scrimColor: volatileField(z.string().default(DEFAULT_SCRIM_COLOR).description('遮罩颜色（#rrggbb 或 rgb(...)）；无法解析时回落到旧字段 scrim')),
  scrimAlpha: volatileField(z.number().min(0).max(1).step(0.01).default(DEFAULT_SCRIM_ALPHA).description('遮罩浓度（0–1）')),
  scrim: volatileField(z.string().default('').description('（旧字段）任意 CSS 颜色，如 rgba(8, 9, 14, 0.35)')),
});

/** Unwrap volatile boxes (and callable config sources) into a plain object. */
export function plainConfig(source) {
  const out = {};
  const raw = typeof source === 'function' ? source() : source;
  if (raw === null || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw)) {
    out[key] = value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
  }
  return out;
}

function number(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number.parseFloat(value);
  return Number.NaN;
}

function unit(value, fallback) {
  const parsed = number(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback;
}

function pixels(value, fallback) {
  const parsed = number(value);
  return Number.isFinite(parsed) ? Math.min(64, Math.max(0, parsed)) : fallback;
}

function choose(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

/**
 * Position of the floating launcher, stored as fractions of the *free* viewport
 * (viewport size minus the button size), so it stays put & stays on-screen even
 * when the window is resized or the host restarts on a different port.
 * `null` means "use the default bottom-right corner".
 */
export function parseLauncherPos(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const fx = Number(value.fx);
  const fy = Number(value.fy);
  if (!Number.isFinite(fx) || !Number.isFinite(fy)) return null;
  return { fx: Math.min(1, Math.max(0, fx)), fy: Math.min(1, Math.max(0, fy)) };
}

/** Parse #rgb / #rrggbb / rgb() / rgba() into [r, g, b]; null when unparseable. */
export function parseColor(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  let match = /^#([0-9a-f]{3})$/i.exec(text);
  if (match !== null) return [0, 1, 2].map((index) => Number.parseInt(match[1][index] + match[1][index], 16));
  match = /^#([0-9a-f]{6})$/i.exec(text);
  if (match !== null) return [0, 2, 4].map((index) => Number.parseInt(match[1].slice(index, index + 2), 16));
  match = /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/i.exec(text);
  if (match !== null) return [1, 2, 3].map((index) => Math.round(Number.parseFloat(match[index])));
  return null;
}

/** 遮罩的最终 CSS 颜色：颜色 + 浓度优先，其次旧的 scrim 字符串，最后内置兜底。 */
export function scrimCss(config) {
  const color = parseColor(config.scrimColor);
  if (color !== null) return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${config.scrimAlpha})`;
  const legacy = typeof config.scrim === 'string' ? config.scrim.trim() : '';
  return legacy !== '' ? legacy : DEFAULT_SCRIM_CSS;
}

export function normalizeConfig(source) {
  const raw = plainConfig(source);
  const configuredPath = typeof raw.imagePath === 'string' ? raw.imagePath.trim() : '';
  const config = {
    enabled: raw.enabled !== false,
    // An empty path means "use the picture bundled with the plugin". Storing ''
    // (rather than the absolute path) keeps this valid after a plugin upgrade
    // that replaces the installed copy at a different location.
    imagePath: configuredPath !== '' ? configuredPath : BUNDLED_DEFAULT_IMAGE,
    opacity: unit(raw.opacity, 1),
    blur: pixels(raw.blur, 0),
    panelAlpha: unit(raw.panelAlpha, DEFAULT_PANEL_ALPHA),
    backdropBlur: pixels(raw.backdropBlur, 0),
    fill: choose(raw.fill, FILL_MODES, DEFAULT_FILL),
    scrimColor: typeof raw.scrimColor === 'string' ? raw.scrimColor : DEFAULT_SCRIM_COLOR,
    scrimAlpha: unit(raw.scrimAlpha, DEFAULT_SCRIM_ALPHA),
    scrim: typeof raw.scrim === 'string' ? raw.scrim : '',
    launcherPos: parseLauncherPos(raw.launcherPos),
  };
  return { ...config, scrim: scrimCss(config), version: WALLPAPER_VERSION };
}

/** 客户端用它判断"要不要重画"；同一份配置 + 同一份文件 → 同一个字符串。 */
export function revisionOf(settings, extra = '') {
  return [
    WALLPAPER_VERSION,
    settings.enabled ? 1 : 0,
    settings.imagePath,
    settings.opacity,
    settings.blur,
    settings.panelAlpha,
    settings.backdropBlur,
    settings.fill,
    settings.scrim,
    extra,
  ].join('|');
}

/** The 10 knobs, without the internal version stamp. */
export function publicConfig(settings) {
  const { version, ...rest } = settings;
  return rest;
}

/** Whitelist + coerce everything that arrives from the panel. */
export function pickConfig(body) {
  const out = {};
  for (const key of CONFIG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    let value = body[key];
    if (key === 'enabled') {
      value = !(value === false || value === 'false' || value === 0 || value === '0' || value === null);
    }
    if (key === 'launcherPos') {
      value = parseLauncherPos(value);
    }
    out[key] = value;
  }
  return out;
}

/** Recognise a real image by its magic bytes; never trust the extension/type. */
export function sniffImage(input) {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: '.jpg', type: 'image/jpeg' };
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: '.png', type: 'image/png' };
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('ascii'))) return { ext: '.gif', type: 'image/gif' };
  if (b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return { ext: '.webp', type: 'image/webp' };
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return { ext: '.bmp', type: 'image/bmp' };
  if (b.length >= 12 && b.subarray(4, 8).toString('ascii') === 'ftyp' && /avif|avis/.test(b.subarray(8, 12).toString('ascii'))) return { ext: '.avif', type: 'image/avif' };
  return null;
}

/** Reject anything that is not a public unicast IPv4/IPv6 address. */
export function ipIsPrivate(ip) {
  const version = isIP(ip);
  if (version === 4) {
    const p = ip.split('.').map(Number);
    const [a, b, c] = p;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;           // CGNAT 100.64/10
    if (a === 169 && b === 254) return true;                       // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;              // 172.16/12
    if (a === 192 && b === 168) return true;                       // 192.168/16
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return true;          // benchmarking
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a >= 224) return true;                                     // multicast + reserved
    return false;
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('::ffff:')) return ipIsPrivate(lower.slice(7));
    if (/^f[cd]/.test(lower)) return true;                          // fc00::/7 unique local
    if (/^fe[89ab]/.test(lower)) return true;                       // fe80::/10 link-local
    return false;
  }
  return true; // not an IP at all → refuse
}

/** Validate one URL hop. Throws on anything that could reach the host's LAN. */
export async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('invalid url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http(s) URLs are allowed');
  if (url.username !== '' || url.password !== '') throw new Error('credentials in the URL are not allowed');
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (port !== 80 && port !== 443) throw new Error('only default ports 80/443 are allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  if (isIP(host)) {
    addresses = [host];
  } else {
    const records = await lookup(host, { all: true, verbatim: true });
    addresses = records.map((record) => record.address);
  }
  if (addresses.length === 0) throw new Error('dns lookup returned no address');
  for (const address of addresses) {
    if (ipIsPrivate(address)) throw new Error(`blocked address: ${address}`);
  }
  return url;
}

/** Fetch a remote image, re-validating every redirect hop. */
async function importFromUrl(rawUrl) {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = await assertPublicUrl(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), URL_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': 'dsh-wallpaper/3', accept: 'image/*,*/*;q=0.8' },
      });
    } finally {
      clearTimeout(timer);
    }
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.arrayBuffer().catch(() => {});
      current = new URL(location, url).toString();
      continue;
    }
    if (!response.ok) throw new Error(`upstream returned HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) throw new Error('image is too large');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error('image is too large');
    const sniffed = sniffImage(buffer);
    if (sniffed === null) throw new Error('the response is not a recognised image');
    return { buffer, ext: sniffed.ext, contentType: response.headers.get('content-type') ?? sniffed.type };
  }
  throw new Error('too many redirects');
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(text);
}

async function readBody(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error('request body is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, limit = 64 * 1024) {
  try {
    const raw = await readBody(req, limit);
    if (raw.length === 0) return {};
    const parsed = JSON.parse(raw.toString('utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function describe(settings, dir) {
  const base = {
    version: settings.version,
    enabled: settings.enabled,
    imagePath: settings.imagePath,
    opacity: settings.opacity,
    blur: settings.blur,
    panelAlpha: settings.panelAlpha,
    fill: settings.fill,
    backdropBlur: settings.backdropBlur,
    scrim: settings.scrim,
    scrimColor: settings.scrimColor,
    scrimAlpha: settings.scrimAlpha,
    launcherPos: settings.launcherPos,
    presets: PRESETS,
    wallpaperDir: dir,
  };
  if (!settings.enabled) {
    return { ok: false, ...base, reason: 'disabled', error: 'wallpaper is turned off', revision: revisionOf(settings) };
  }
  if (settings.imagePath === '') {
    return { ok: false, ...base, reason: 'unconfigured', error: 'no imagePath configured', revision: revisionOf(settings) };
  }
  let info;
  try {
    info = await stat(settings.imagePath);
  } catch (error) {
    return {
      ok: false,
      ...base,
      reason: 'missing',
      error: String(error?.code ?? error?.message ?? error),
      revision: revisionOf(settings),
    };
  }
  if (!info.isFile()) {
    return { ok: false, ...base, reason: 'not-a-file', error: 'not a file', revision: revisionOf(settings) };
  }
  const extra = `${info.size}-${Math.round(info.mtimeMs)}`;
  return {
    ok: true,
    ...base,
    contentType: CONTENT_TYPES[extname(settings.imagePath).toLowerCase()] ?? 'application/octet-stream',
    bytes: info.size,
    mtimeMs: info.mtimeMs,
    revision: revisionOf(settings, extra),
  };
}

async function sendImage(req, res, settings) {
  if (settings.imagePath === '') return sendJson(res, 404, { ok: false, error: 'no imagePath configured' });
  let info;
  try {
    info = await stat(settings.imagePath);
  } catch {
    return sendJson(res, 404, { ok: false, error: 'image not found' });
  }
  if (!info.isFile()) return sendJson(res, 404, { ok: false, error: 'not a file' });

  const etag = `W/"${info.size}-${Math.round(info.mtimeMs)}"`;
  res.setHeader('content-type', CONTENT_TYPES[extname(settings.imagePath).toLowerCase()] ?? 'application/octet-stream');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('etag', etag);
  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.setHeader('content-length', String(info.size));
  if (req.method === 'HEAD') {
    res.statusCode = 200;
    res.end();
    return;
  }
  res.statusCode = 200;
  const stream = createReadStream(settings.imagePath);
  stream.on('error', () => {
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'read failed' });
    else res.destroy();
  });
  stream.pipe(res);
}

/** A tiny, atomic persistent store for the panel's overrides. */
function createStore(dir) {
  const file = join(dir, 'settings.json');
  return {
    file,
    async load() {
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'));
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch {
        /* no override yet, or a torn/unparseable file → fall back to the patch */
      }
      return {};
    },
    async save(data) {
      await mkdir(dir, { recursive: true });
      const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      await rename(tmp, file);
    },
    async patch(patch) {
      const next = { ...(await this.load()), ...patch };
      await this.save(next);
      return next;
    },
    async reset() {
      await unlink(file).catch(() => {});
    },
  };
}

async function saveImage(buffer, ext, dir) {
  await mkdir(dir, { recursive: true });
  const target = join(dir, `wallpaper-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}${ext}`)
    .replace(/\\/g, '/');
  await writeFile(target, buffer);
  return target;
}

/**
 * 老一代 settings 服务需要显式安装表单区块；新一代（有 describe、无
 * installSection）会直接读取本插件导出的 volatile `Config`。两种都兼容，
 * 但控制面板不依赖它们 —— 它走下面这些 /api 路由。
 */
function installSettings(ctx, config, hooks) {
  if (typeof ctx?.inject !== 'function') return;
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx?.settings;
    if (settings && typeof settings.installSection === 'function') {
      settings.installSection(ctx, NAMESPACE, Config, config, hooks);
    }
    return () => {};
  });
}

export function apply(ctx, config = {}) {
  const raw = plainConfig(config);
  const dir = (
    typeof process.env.DSH_WALLPAPER_DIR === 'string' && process.env.DSH_WALLPAPER_DIR.trim() !== ''
      ? process.env.DSH_WALLPAPER_DIR.trim()
      : typeof raw.wallpaperDir === 'string' && raw.wallpaperDir.trim() !== ''
        ? raw.wallpaperDir.trim()
        : DEFAULT_WALLPAPER_DIR
  ).replace(/\\/g, '/');

  const store = createStore(dir);
  let source = config;
  const read = async () => normalizeConfig({ ...plainConfig(source), ...(await store.load()) });

  const handleConfig = async (req, res) => {
    const body = await readJson(req, 64 * 1024);
    if (body === null) return sendJson(res, 400, { ok: false, error: 'invalid json' });
    if (body.useDefault === true) {
      // The bundled picture is selected by an EMPTY imagePath (normalizeConfig
      // resolves '' to BUNDLED_DEFAULT_IMAGE), so this also clears any upload /
      // URL import the user had chosen. Explicitly re-enable the background.
      await store.patch({ imagePath: '', enabled: true });
    } else if (body.reset === true) {
      // "Reset to config" means the *look* knobs, not where the user parked the
      // launcher. Keep that one preference across the wipe.
      const pos = parseLauncherPos((await store.load()).launcherPos);
      await store.reset();
      if (pos !== null) await store.patch({ launcherPos: pos });
    } else {
      const patch = pickConfig(body);
      if (Object.keys(patch).length === 0) return sendJson(res, 400, { ok: false, error: 'no known config keys' });
      await store.patch(patch);
    }
    return sendJson(res, 200, { ok: true, config: publicConfig(await read()) });
  };

  const handleClear = async (req, res) => {
    await readJson(req, 4096);
    await store.patch({ enabled: false });
    return sendJson(res, 200, { ok: true, config: publicConfig(await read()) });
  };

  const handleUpload = async (req, res) => {
    const body = await readJson(req, MAX_IMAGE_BYTES * 2 + 4096);
    if (body === null) return sendJson(res, 400, { ok: false, error: 'invalid json' });
    const encoded = typeof body.dataBase64 === 'string' ? body.dataBase64 : '';
    if (encoded === '' || !/^[A-Za-z0-9+/=\s]+$/.test(encoded)) {
      return sendJson(res, 400, { ok: false, error: 'missing or malformed dataBase64' });
    }
    const buffer = Buffer.from(encoded, 'base64');
    if (buffer.length === 0) return sendJson(res, 400, { ok: false, error: 'empty image' });
    if (buffer.length > MAX_IMAGE_BYTES) return sendJson(res, 413, { ok: false, error: 'image is too large' });
    const sniffed = sniffImage(buffer);
    if (sniffed === null) return sendJson(res, 415, { ok: false, error: 'unsupported image format' });
    const target = await saveImage(buffer, sniffed.ext, dir);
    await store.patch({ imagePath: target, enabled: true });
    return sendJson(res, 200, { ok: true, imagePath: target, bytes: buffer.length, contentType: sniffed.type });
  };

  const handleImportUrl = async (req, res) => {
    const body = await readJson(req, 4096);
    if (body === null || typeof body.url !== 'string' || body.url.trim() === '') {
      return sendJson(res, 400, { ok: false, error: 'missing url' });
    }
    let fetched;
    try {
      fetched = await importFromUrl(body.url.trim());
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
    const target = await saveImage(fetched.buffer, fetched.ext, dir);
    await store.patch({ imagePath: target, enabled: true });
    return sendJson(res, 200, { ok: true, imagePath: target, bytes: fetched.buffer.length, contentType: fetched.contentType });
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const rest = url.pathname.slice(API_PREFIX.length);
        const settings = await read();
        if (rest === '/info' && req.method === 'GET') return sendJson(res, 200, await describe(settings, dir));
        if (rest === '/image' && (req.method === 'GET' || req.method === 'HEAD')) return sendImage(req, res, settings);
        if (rest === '/config' && req.method === 'POST') return await handleConfig(req, res);
        if (rest === '/clear' && req.method === 'POST') return await handleClear(req, res);
        if (rest === '/upload' && req.method === 'POST') return await handleUpload(req, res);
        if (rest === '/import-url' && req.method === 'POST') return await handleImportUrl(req, res);
        return sendJson(res, 404, { ok: false, error: `unknown route "${rest}"` });
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    },
  }), 'wallpaper: api');

  installSettings(ctx, config, {
    setSource: (next) => { source = next; },
    onChange: () => {},
  });
}
