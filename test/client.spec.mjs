/**
 * Offline exercise of dsh-wallpaper's browser half.
 *
 * The client bundle is a plain `window.__ModuleLoader__.load({id, factory})`
 * call, so a stub loader plus a fake DOM is enough to run the real file. Two
 * layers are covered:
 *
 *   1. The wallpaper painter — layer/stylesheet appear only when the host reports
 *      a usable image, every rule is scoped to the flag attribute, the dark-theme
 *      override exists, a revision change repaints without a reload, disposal
 *      removes everything. These scenarios use a THIN dom (no addEventListener),
 *      so the control panel stays out of the way (graceful degradation).
 *   2. The self-contained control panel — with a RICH dom (addEventListener), the
 *      panel mounts, the status badge / preview / presets reflect /info, a slider
 *      drag POSTs to /config, and the action buttons POST to their endpoints.
 *
 * Each scenario loads the module fresh and stubs the timer, because the real
 * file polls /info on an interval (that is the whole point of the feature, and
 * an unstubbed interval keeps node alive forever).
 *
 * Run: node test/client.spec.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

const results = [];
const check = (label, condition, detail) => {
  results.push({ label, ok: Boolean(condition) });
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${label}${detail === undefined ? '' : `  -> ${detail}`}`);
};

// ---- a DOM small enough to reason about -------------------------------------

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.id = '';
    this.textContent = '';
    this.attributes = new Map();
    this.children = [];
    this.parent = null;
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  getAttribute(name) {
    return this.attributes.get(name);
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  append(child) {
    child.parent = this;
    this.children.push(child);
  }
  prepend(child) {
    child.parent = this;
    this.children.unshift(child);
  }
  remove() {
    if (this.parent === null) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }
}

/** A DOM element that can actually receive events — enough to mount the panel. */
class RichElement extends FakeElement {
  constructor(tagName) {
    super(tagName);
    this.listeners = new Map();
  }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((item) => item !== fn));
  }
  fire(type, event = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

function makeDom(factory = (tag) => new FakeElement(tag)) {
  const body = factory('body');
  const head = factory('head');

  const findById = (id) => {
    const walk = (node) => {
      for (const child of node.children) {
        if (child.id === id) return child;
        const hit = walk(child);
        if (hit !== null) return hit;
      }
      return null;
    };
    return walk(head) ?? walk(body);
  };

  const countById = (id) => {
    let total = 0;
    const walk = (node) => {
      for (const child of node.children) {
        if (child.id === id) total += 1;
        walk(child);
      }
    };
    walk(head);
    walk(body);
    return total;
  };

  return { body, head, createElement: factory, getElementById: findById, byId: findById, countById };
}

/** Install one scenario's globals and load a fresh copy of the module. */
function scenario({ info, respond, rich = false }) {
  const dom = makeDom(rich ? (tag) => new RichElement(tag) : undefined);
  const warnings = [];
  const timers = [];
  const cleared = [];
  const calls = [];

  dom.activeElement = null;
  globalThis.document = dom;
  globalThis.getComputedStyle = () => ({ backgroundColor: 'rgb(10, 12, 16)' });
  globalThis.fetch = respond ?? (async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body });
    return { ok: true, json: async () => info };
  });
  globalThis.setInterval = (fn, ms) => {
    timers.push({ fn, ms });
    return timers.length;
  };
  globalThis.clearInterval = (id) => {
    cleared.push(id);
  };
  console.warn = (...args) => warnings.push(args.join(' '));
  console.error = (...args) => warnings.push(args.join(' '));

  let definition;
  globalThis.window = {
    innerWidth: 1200,
    innerHeight: 800,
    __ModuleLoader__: {
      load(entry) {
        definition = entry;
      },
    },
  };

  new Function('window', source)(globalThis.window);
  return { dom, warnings, definition, timers, cleared, calls };
}

function makeCtx() {
  const effects = [];
  return {
    effects,
    effect(fn, label) {
      const dispose = fn();
      effects.push({ label, dispose });
      return () => {};
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Two macrotasks: one for the fetch promise, one for the `.then` body. */
const settle = async () => {
  await flush();
  await flush();
};

const INFO = {
  ok: true,
  enabled: true,
  imagePath: 'C:/x/bg.jpg',
  opacity: 1,
  blur: 0,
  panelAlpha: 0.82,
  backdropBlur: 0,
  fill: 'cover',
  scrim: 'rgba(8, 9, 14, 0.35)',
  scrimColor: '#08090e',
  scrimAlpha: 0.35,
  presets: [
    { id: 'clear', label: '清晰', hint: '文字优先', values: { panelAlpha: 0.55 } },
    { id: 'frost', label: '磨砂', hint: '毛玻璃', values: { backdropBlur: 12 } },
  ],
  contentType: 'image/jpeg',
  bytes: 50,
  mtimeMs: 1762300000000,
  revision: 'v2|1|C:/x/bg.jpg|1|0|0.82|0|cover|rgba(8, 9, 14, 0.35)|' + '50-1762300000000',
  version: 2,
};

const INFO2 = {
  ...INFO,
  panelAlpha: 0.5,
  fill: 'contain',
  backdropBlur: 4,
  revision: `${INFO.revision}#moved`,
};

/** Drive one poll tick and let its fetch settle. */
async function tick(timers) {
  timers[0]?.fn();
  await settle();
}

// ---- contract ---------------------------------------------------------------

{
  const { definition } = scenario({ info: INFO });
  check('registers exactly one module', definition !== undefined);
  check('module id matches the package name', definition?.id === 'dsh-shell-wallpaper', definition?.id);

  const exported = definition.factory();
  check('exports name', typeof exported.name === 'string', exported.name);
  check('exports apply', typeof exported.apply === 'function');
  check(
    'declares no hard service dependency',
    Array.isArray(exported.inject) && exported.inject.length === 0,
    JSON.stringify(exported.inject),
  );
}

// ---- happy path -------------------------------------------------------------

{
  const { dom, timers, definition } = scenario({ info: INFO });
  const ctx = makeCtx();
  definition.factory().apply(ctx);
  await settle();

  check('registers one effect', ctx.effects.length === 1, ctx.effects.length);
  check('the effect is labelled', ctx.effects[0]?.label === 'dsh-wallpaper: paint', ctx.effects[0]?.label);
  check('polls on a timer', timers.length === 1 && timers[0].ms === 900, JSON.stringify(timers.map((t) => t.ms)));

  const style = dom.getElementById('dsh-wallpaper-style');
  const layer = dom.getElementById('dsh-wallpaper-layer');

  check('installs the stylesheet', style !== null);
  check('installs the image layer', layer !== null);
  check('flags the body', dom.body.attributes.get('data-dsh-wallpaper') === '1', dom.body.attributes.get('data-dsh-wallpaper'));
  check('the layer is aria-hidden', layer?.attributes.get('aria-hidden') === 'true');

  const css = style?.textContent ?? '';

  check('the image url carries the mtime', css.includes('/wallpaper/api/image?v=1762300000000'));
  check('the layer sits under the shell', /#dsh-wallpaper-layer\s*\{[^}]*z-index:\s*-1/.test(css));
  check('the layer does not eat the window drag strip', css.includes('-webkit-app-region: initial'));
  check('a scrim exists', css.includes('rgba(8, 9, 14, 0.35)'));
  check('the default fill is cover', css.includes('background-size: cover'));
  check(
    'the base token is re-pointed at a translucent tint',
    /--dsw-alias-bg-base:\s*color-mix\(in srgb, rgb\(10, 12, 16\) 82%/.test(css),
  );
  check(
    'the sidebar token is re-pointed too',
    /--dsw-specific-sidebar-fill:\s*color-mix\(in srgb, rgb\(10, 12, 16\) 92%/.test(css),
  );
  check('the dark-theme override is present', css.includes('body[data-ds-dark-theme][data-dsh-wallpaper]'));
  check(
    'every token override is scoped to the flag',
    css
      .split('}')
      .filter((rule) => rule.includes('--dsw-alias-bg-base'))
      .every((rule) => rule.includes('data-dsh-wallpaper')),
  );

  // a thin DOM must not mount a control panel (graceful degradation)
  check('a thin dom mounts no control panel', dom.getElementById('dsh-wallpaper-launcher') === null);

  // disposal, on this same live instance
  ctx.effects[0].dispose();
  check('disposal removes the layer', dom.getElementById('dsh-wallpaper-layer') === null);
  check('disposal removes the stylesheet', dom.getElementById('dsh-wallpaper-style') === null);
  check('disposal clears the flag', dom.body.attributes.get('data-dsh-wallpaper') === undefined);
}

// ---- the poll: same revision is a no-op, a moved revision repaints ----------

{
  let payload = INFO;
  const { dom, timers, definition } = scenario({ respond: async () => ({ ok: true, json: async () => payload }) });
  const ctx = makeCtx();
  definition.factory().apply(ctx);
  await settle();

  const first = dom.getElementById('dsh-wallpaper-style');
  await tick(timers);
  check('an unchanged revision does not repaint', dom.getElementById('dsh-wallpaper-style') === first);
  check('the stylesheet is never stacked', dom.countById('dsh-wallpaper-style') === 1, dom.countById('dsh-wallpaper-style'));

  payload = INFO2;
  await tick(timers);
  const second = dom.getElementById('dsh-wallpaper-style');
  const css = second?.textContent ?? '';
  check('a moved revision repaints without a reload', second !== null && second !== first);
  check('the new panel alpha reaches the css', /--dsw-alias-bg-base:\s*color-mix\(in srgb, rgb\(10, 12, 16\) 50%/.test(css));
  check('a new fill mode reaches the css', css.includes('background-size: contain'));
  check('a new backdrop blur reaches the css', css.includes('backdrop-filter: blur(4px)'));

  ctx.effects[0].dispose();
}

// ---- self-heal: the SPA knocking our frame out is repaired on the next tick --

{
  let payload = INFO;
  const { dom, timers, definition } = scenario({ respond: async () => ({ ok: true, json: async () => payload }) });
  const ctx = makeCtx();
  definition.factory().apply(ctx);
  await settle();

  const first = dom.getElementById('dsh-wallpaper-style');
  check('painted before the sabotage', first !== null);

  // Simulate a SPA navigation / theme switch that removes our nodes and flag.
  first.remove();
  dom.getElementById('dsh-wallpaper-layer')?.remove();
  dom.body.removeAttribute('data-dsh-wallpaper');
  check('the sabotage really removed the frame', dom.getElementById('dsh-wallpaper-style') === null);

  // Same revision as before, so the old code would have returned early here.
  await tick(timers);
  check('an unchanged revision still self-heals a broken frame', dom.getElementById('dsh-wallpaper-style') !== null);
  check('self-heal restores the image layer', dom.getElementById('dsh-wallpaper-layer') !== null);
  check('self-heal restores the body flag', dom.body.attributes.get('data-dsh-wallpaper') === '1');
  check('self-heal never stacks stylesheets', dom.countById('dsh-wallpaper-style') === 1);

  ctx.effects[0].dispose();
}

// ---- switching the background off removes everything -----------------------

{
  let payload = INFO;
  const { dom, timers, definition } = scenario({ respond: async () => ({ ok: true, json: async () => payload }) });
  const ctx = makeCtx();
  definition.factory().apply(ctx);
  await settle();
  check('painted before the switch off', dom.getElementById('dsh-wallpaper-layer') !== null);

  payload = { ...INFO, ok: false, enabled: false, reason: 'disabled', error: 'wallpaper is turned off', revision: `${INFO.revision}#off` };
  await tick(timers);
  check('turning it off removes the layer', dom.getElementById('dsh-wallpaper-layer') === null);
  check('turning it off removes the stylesheet', dom.getElementById('dsh-wallpaper-style') === null);
  check('turning it off clears the flag', dom.body.attributes.get('data-dsh-wallpaper') === undefined);

  ctx.effects[0].dispose();
}

// ---- frosted panels --------------------------------------------------------

{
  const { dom, definition } = scenario({ info: INFO2 });
  const shell = dom.createElement('div');
  shell.getBoundingClientRect = () => ({ width: 1200, height: 700 });
  dom.body.append(shell);

  const ctx = makeCtx();
  definition.factory().apply(ctx);
  await settle();

  check('a large opaque shell surface is frosted', shell.attributes.get('data-dsh-wp-frost') === '4', shell.attributes.get('data-dsh-wp-frost'));
  check('the frost rule is scoped to the flag', /body\[data-dsh-wallpaper\]\s*\[data-dsh-wp-frost\]/.test(dom.getElementById('dsh-wallpaper-style')?.textContent ?? ''));

  ctx.effects[0].dispose();
  check('disposal removes the frost tag', shell.attributes.get('data-dsh-wp-frost') === undefined);
}

// ---- an unusable image must not repaint the shell ---------------------------

{
  const { dom, warnings, definition } = scenario({
    respond: async () => ({ ok: true, json: async () => ({ ok: false, error: 'no imagePath configured' }) }),
  });
  const ctx = makeCtx();
  definition.factory().apply(ctx);
  await settle();

  check(
    'a refused image installs nothing',
    dom.getElementById('dsh-wallpaper-style') === null && dom.getElementById('dsh-wallpaper-layer') === null,
  );
  check('a refused image leaves the body unflagged', dom.body.attributes.get('data-dsh-wallpaper') === undefined);
  check(
    'a refused image explains itself',
    warnings.some((line) => line.includes('no imagePath configured')),
    warnings.join(' | '),
  );
  ctx.effects[0].dispose();
}

// ---- a transport failure is equally harmless -------------------------------

{
  const { dom, warnings, definition } = scenario({ respond: async () => ({ ok: false, json: async () => null }) });
  const ctx = makeCtx();
  definition.factory().apply(ctx);
  await settle();

  check(
    'a failed request installs nothing',
    dom.getElementById('dsh-wallpaper-style') === null && dom.getElementById('dsh-wallpaper-layer') === null,
  );
  check('a failed request leaves the body unflagged', dom.body.attributes.get('data-dsh-wallpaper') === undefined);
  check(
    'a failed request does not report a paint error',
    warnings.every((line) => !line.includes('failed to paint')),
    warnings.join(' | '),
  );
  ctx.effects[0].dispose();
}

// ---- a late response after disposal must not paint -------------------------

{
  let release;
  const { dom, definition } = scenario({
    respond: () => new Promise((resolve) => {
      release = () => resolve({ ok: true, json: async () => INFO });
    }),
  });
  const ctx = makeCtx();
  definition.factory().apply(ctx);
  await flush();
  ctx.effects[0].dispose();
  release();
  await settle();

  check(
    'a disposed plugin ignores its own late response',
    dom.getElementById('dsh-wallpaper-layer') === null && dom.getElementById('dsh-wallpaper-style') === null,
  );
}

// ---- disposal stops the poll ----------------------------------------------

{
  const { definition, cleared } = scenario({ info: INFO });
  const ctx = makeCtx();
  definition.factory().apply(ctx);
  await settle();
  ctx.effects[0].dispose();
  check('disposal stops the poll', cleared.length === 1, JSON.stringify(cleared));
}

// ============================================================ control panel ==
// A RICH dom (elements have addEventListener) lets the self-contained panel
// mount. Its POSTs are captured in `calls`; GET /info always returns INFO.

function panelScenario(initialInfo = INFO) {
  let payload = initialInfo;
  const calls = [];
  const result = scenario({
    rich: true,
    respond: async (url, init) => {
      const method = init?.method ?? 'GET';
      calls.push({ url: String(url), method, body: init?.body });
      if (method === 'POST') return { ok: true, json: async () => ({ ok: true }) };
      return { ok: true, json: async () => payload };
    },
  });
  return { ...result, calls, setInfo: (next) => { payload = next; } };
}

{
  const { dom, definition } = panelScenario();
  const ctx = makeCtx();
  definition.factory().apply(ctx);
  await settle();

  check('a rich dom mounts the launcher', dom.getElementById('dsh-wallpaper-launcher') !== null);
  check('a rich dom mounts the panel', dom.getElementById('dsh-wallpaper-panel') !== null);
  check('a rich dom installs the panel stylesheet', dom.getElementById('dsh-wallpaper-panel-style') !== null);
  check('the wallpaper painter still runs alongside the panel', dom.getElementById('dsh-wallpaper-layer') !== null);

  const status = dom.getElementById('dsh-wp-status');
  check('the status badge reports an enabled background', status?.textContent === '✓ 背景已启用', status?.textContent);
  check('the status badge carries the ok state', status?.getAttribute('data-state') === 'ok');

  const preview = dom.getElementById('dsh-wp-preview');
  check('the preview thumbnail points at /image', String(preview?.src ?? '').includes('/wallpaper/api/image'), preview?.src);
  check('the preview thumbnail is shown', preview?.getAttribute('data-show') === '1');

  const opacity = dom.getElementById('dsh-wp-opacity');
  check('the opacity slider is seeded from /info', String(opacity?.value) === '1', String(opacity?.value));

  const presets = dom.getElementById('dsh-wp-presets');
  check('two preset buttons are built from /info', presets?.children.length === 2, presets?.children.length);
  check('the preset labels come from /info', presets?.children.map((c) => c.textContent).join(',') === '清晰,磨砂');

  const launcher = dom.getElementById('dsh-wallpaper-launcher');
  const panel = dom.getElementById('dsh-wallpaper-panel');
  launcher.fire('click');
  check('clicking the launcher opens the panel', panel?.getAttribute('data-open') === '1');
  launcher.fire('click');
  check('clicking again closes the panel', panel?.getAttribute('data-open') === undefined);

  ctx.effects[0].dispose();
  check('disposal removes the launcher', dom.getElementById('dsh-wallpaper-launcher') === null);
  check('disposal removes the panel', dom.getElementById('dsh-wallpaper-panel') === null);
  check('disposal removes the panel stylesheet', dom.getElementById('dsh-wallpaper-panel-style') === null);
}

// ---- a slider drag persists via POST /config -------------------------------

{
  const { dom, definition, calls } = panelScenario();
  const ctx = makeCtx();
  definition.factory().apply(ctx);
  await settle();

  const slider = dom.getElementById('dsh-wp-panelAlpha');
  slider.value = '0.42';
  slider.fire('input');
  await settle();

  const configPosts = calls.filter((c) => c.method === 'POST' && c.url.includes('/config'));
  check('a slider drag POSTs to /config', configPosts.length === 1, JSON.stringify(configPosts));
  check('the POST body carries the new value', /panelAlpha/.test(configPosts[0]?.body ?? '') && /0.42/.test(configPosts[0]?.body ?? ''), configPosts[0]?.body);

  ctx.effects[0].dispose();
}

// ---- action buttons hit their own endpoints --------------------------------

{
  const { dom, definition, calls } = panelScenario();
  const ctx = makeCtx();
  definition.factory().apply(ctx);
  await settle();

  dom.getElementById('dsh-wp-default').fire('click');
  await settle();
  check('the default-picture button POSTs /config with useDefault', calls.some((c) => c.url.includes('/config') && /"useDefault":true/.test(c.body ?? '')));

  dom.getElementById('dsh-wp-clear').fire('click');
  await settle();
  check('the clear button POSTs to /clear', calls.some((c) => c.method === 'POST' && c.url.includes('/clear')));

  dom.getElementById('dsh-wp-reset').fire('click');
  await settle();
  check('the reset button POSTs /config with reset', calls.some((c) => c.url.includes('/config') && /"reset":true/.test(c.body ?? '')));

  dom.getElementById('dsh-wp-url').value = 'https://example.com/a.png';
  dom.getElementById('dsh-wp-url-apply').fire('click');
  await settle();
  check('apply-link POSTs to /import-url with the url', calls.some((c) => c.url.includes('/import-url') && /example\.com/.test(c.body ?? '')));

  ctx.effects[0].dispose();
}

// ---- a switched-off host updates the badge and hides the preview -----------

{
  const { dom, definition, setInfo, timers } = panelScenario();
  const ctx = makeCtx();
  definition.factory().apply(ctx);
  await settle();

  setInfo({ ...INFO, ok: false, enabled: false, reason: 'disabled', error: 'off', revision: `${INFO.revision}#off` });
  await tick(timers);
  const status = dom.getElementById('dsh-wp-status');
  check('a switched-off host flips the badge', status?.textContent === '✗ 已关闭', status?.textContent);
  check('a switched-off host marks the bad state', status?.getAttribute('data-state') === 'bad');
  check('a switched-off host hides the preview', dom.getElementById('dsh-wp-preview')?.getAttribute('data-show') === undefined);

  ctx.effects[0].dispose();
}

// ---- summary ---------------------------------------------------------------

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;
