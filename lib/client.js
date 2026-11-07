/**
 * dsh-wallpaper — client half (v3).
 *
 * Paints ONE image behind the whole DSH shell, keeps it in sync with the host's
 * live config (so changes show up without F5), AND ships a self-contained
 * floating control panel that drives the host's /wallpaper/api endpoints:
 *
 *   /info        read current state + presets      (GET)
 *   /config      persist knobs / reset / useDefault (POST)
 *   /upload      save a picked image               (POST, base64)
 *   /import-url  save an image from a URL          (POST, SSRF-guarded)
 *   /clear       turn the background off           (POST)
 *   /image       stream the configured picture     (GET, preview thumbnail)
 *
 * Why a self-built panel instead of registering into the host settings shell:
 * the shipped settings README states "no published client builds pages from the
 * schema yet", so a schema-only form would be invisible; and registering a new
 * client slot has historically caused a full white-screen (one pending slot
 * fails the whole web boot). This panel is plain DOM inside a single try/catch
 * — if anything about it is unsupported, the wallpaper painting still works and
 * the rest of the app is untouched.
 *
 * Why this is more than a `background-image` on `body`:
 *
 *   The shell paints its own opaque surfaces over everything. From
 *   `@deepseek-ai/dsh-client-ui-layout`'s AppFrame.module.css:
 *
 *     .mP3x-q_frame    { background: var(--dsw-alias-bg-base) }
 *     .mP3x-q_centerCol{ background: var(--dsw-alias-bg-base) }
 *     .mP3x-q_sidebarCol{ background: var(--dsw-specific-sidebar-fill) }
 *
 *   So the image goes on a `z-index: -1` layer attached to <body>, and those
 *   two tokens are re-pointed at translucent tints of themselves. The class
 *   names are hashed (`mP3x-q_`), so nothing here matches on the hash.
 *
 *   Dark mode is the trap: the theme package appends its palette stylesheet to
 *   <head> AFTER this one, and `body[data-ds-dark-theme]` has equal specificity
 *   (0,1,1) but comes later, so it repaints the frame with an opaque dark colour
 *   and hides the image. The overrides are therefore repeated under the
 *   higher-specificity `body[data-ds-dark-theme][data-dsh-wallpaper]` (0,2,1).
 *
 * Live sync: the host exposes a `revision` string on /info that changes when
 * any knob or the file changes. We poll it (~1/s while the tab is visible) and
 * repaint only when it moves. After any panel action we force one immediate
 * poll so a slider drag feels instant rather than waiting for the next tick.
 */

window.__ModuleLoader__.load({
  id: 'dsh-shell-wallpaper',
  factory() {
    const name = 'dsh-shell-wallpaper-client';
    const inject = [];

    const API = '/wallpaper/api';
    const STYLE_ID = 'dsh-wallpaper-style';
    const LAYER_ID = 'dsh-wallpaper-layer';
    const FLAG = 'data-dsh-wallpaper';
    const FROST_ATTR = 'data-dsh-wp-frost';
    const PANEL_STYLE_ID = 'dsh-wallpaper-panel-style';
    const LAUNCHER_ID = 'dsh-wallpaper-launcher';
    const PANEL_ID = 'dsh-wallpaper-panel';
    const POLL_MS = 900;
    const FROST_RESCAN_TICKS = 3;
    const FROST_MIN_AREA = 0.2;
    const FROST_MAX_NODES = 8;
    const LAUNCHER_SIZE = 44;   // must match the CSS width/height
    const LAUNCHER_EDGE = 18;   // default inset from each viewport edge
    const DRAG_THRESHOLD = 4;   // px of movement before a press counts as a drag

    /** Elements currently carrying the frost attribute (module scope: one page, one DOM). */
    let frosted = [];
    /** The mounted control panel, or null when the host DOM is too thin to support it. */
    let activePanel = null;

    const PANEL_CSS = `
#dsh-wallpaper-launcher, #dsh-wallpaper-panel {
  position: fixed; z-index: 2147483000; box-sizing: border-box;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
}
#dsh-wallpaper-launcher {
  right: 18px; bottom: 18px; width: 44px; height: 44px; border-radius: 50%;
  border: 1px solid rgba(255,255,255,.18); background: rgba(24,26,32,.92);
  color: #fff; font-size: 20px; line-height: 1; cursor: pointer;
  box-shadow: 0 6px 20px rgba(0,0,0,.4); pointer-events: auto;
}
#dsh-wallpaper-launcher:hover { background: rgba(42,46,58,.96); }
#dsh-wallpaper-panel {
  display: none; right: 18px; bottom: 72px; width: 330px; max-height: 80vh;
  overflow: auto; padding: 14px 14px 12px; color: #e9ebf2;
  background: rgba(20,22,29,.96); border: 1px solid rgba(255,255,255,.12);
  border-radius: 12px; box-shadow: 0 20px 56px rgba(0,0,0,.55);
  pointer-events: auto;
}
#dsh-wallpaper-panel[data-open] { display: block; }
#dsh-wallpaper-panel * { box-sizing: border-box; }
.dsh-wp-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.dsh-wp-title { font-size: 14px; font-weight: 600; }
#dsh-wp-status { font-size: 12px; padding: 2px 8px; border-radius: 10px; white-space: nowrap; }
#dsh-wp-status[data-state="ok"] { color: #7ee2a8; background: rgba(46,160,96,.18); }
#dsh-wp-status[data-state="bad"] { color: #ffb4b4; background: rgba(200,60,60,.18); }
#dsh-wp-preview {
  width: 100%; height: 120px; object-fit: cover; border-radius: 8px;
  border: 1px solid rgba(255,255,255,.1); margin-bottom: 10px; background: #11131a;
}
#dsh-wp-preview[data-show] { display: block; }
#dsh-wp-preview:not([data-show]) { display: none; }
.dsh-wp-row { display: flex; align-items: center; gap: 8px; margin: 7px 0; }
.dsh-wp-label { flex: 0 0 84px; font-size: 12px; color: #c3c7d4; }
.dsh-wp-row input[type="range"] { flex: 1 1 auto; min-width: 0; accent-color: #6c8cff; }
.dsh-wp-row input[type="color"] { width: 34px; height: 24px; padding: 0; border: none; background: none; cursor: pointer; }
.dsh-wp-row input[type="text"] { flex: 1 1 0; min-width: 0; }
.dsh-wp-row input[type="checkbox"] { accent-color: #6c8cff; }
.dsh-wp-row select, .dsh-wp-row input[type="text"] {
  background: rgba(10,12,18,.7); color: #e9ebf2; border: 1px solid rgba(255,255,255,.16);
  border-radius: 6px; padding: 4px 6px; font-size: 12px;
}
.dsh-wp-val { flex: 0 0 38px; text-align: right; font-size: 11px; color: #9aa1b4; font-variant-numeric: tabular-nums; }
.dsh-wp-btn {
  background: rgba(108,140,255,.16); color: #cdd8ff; border: 1px solid rgba(108,140,255,.35);
  border-radius: 6px; padding: 5px 9px; font-size: 12px; cursor: pointer;
  white-space: nowrap; flex-shrink: 0;
}
.dsh-wp-btn:hover { background: rgba(108,140,255,.3); }
.dsh-wp-btn.danger { color: #ffc4c4; border-color: rgba(220,90,90,.4); background: rgba(220,90,90,.12); }
.dsh-wp-presets { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.dsh-wp-actions { display: flex; gap: 8px; margin-top: 10px; }
#dsh-wp-message { min-height: 15px; font-size: 11px; color: #9aa1b4; margin-top: 8px; }
.dsh-wp-hint { font-size: 10px; color: #7c8398; line-height: 1.5; margin-top: 6px; }
.dsh-wp-sep { height: 1px; background: rgba(255,255,255,.08); margin: 10px 0; }
`;

    /* ---------------------------------------------------------------- helpers */

    function requestInfo() {
      return fetch(`${API}/info`, { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null);
    }

    /** Local fallback for hosts that do not send a revision. */
    function revisionOf(info) {
      if (typeof info.revision === 'string' && info.revision !== '') return info.revision;
      return [
        info.ok, info.enabled, info.imagePath, info.mtimeMs, info.opacity,
        info.blur, info.panelAlpha, info.backdropBlur, info.fill, info.scrim, info.error,
      ].join('|');
    }

    function formatVal(key, value) {
      if (key === 'blur' || key === 'backdropBlur') return `${Math.round(value)}px`;
      return `${Math.round(value * 100)}%`;
    }

    function el(tag, id, props) {
      const node = document.createElement(tag);
      if (id) node.id = id;
      if (props) {
        for (const [key, value] of Object.entries(props)) node[key] = value;
      }
      return node;
    }

    function on(node, event, handler) {
      if (node && typeof node.addEventListener === 'function') node.addEventListener(event, handler);
    }

    /** Build a labelled row. Returns the row so callers can append it. */
    function row(labelText, ...controls) {
      const box = el('div', null, { className: 'dsh-wp-row' });
      if (labelText !== null) box.append(el('span', null, { className: 'dsh-wp-label', textContent: labelText }));
      for (const control of controls) box.append(control);
      return box;
    }

    /**
     * The colour the shell would have painted without us.
     *
     * Read from the computed style rather than from `--dsw-alias-bg-base` itself,
     * because that token is usually another `var()` and would resolve to literal
     * text like "var(--dsw-static-neutral-bluish-950)".
     */
    let baseColorCache = null;
    /** Last /info that produced a working paint, used to self-heal a broken page. */
    let lastGoodInfo = null;

    function shellBaseColor() {
      const color = getComputedStyle(document.body).backgroundColor;
      // A repaint must not read back a translucent tint it produced itself: mixing
      // that into another color-mix() would make the panel fade a little more on
      // every repaint. Only an opaque colour may refresh the cached base.
      const alpha = /^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)$/.exec(color ?? '');
      const opaque = typeof color === 'string' && color !== '' &&
        color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)' &&
        (alpha === null || Number(alpha[1]) >= 1);
      if (opaque) baseColorCache = color;
      return baseColorCache ?? 'rgb(10, 12, 16)';
    }

    function buildStyle(info, base) {
      const pct = Math.round(info.panelAlpha * 100);
      const blur = Number(info.backdropBlur) > 0 ? Number(info.backdropBlur) : 0;
      const spread = info.blur > 0 ? `inset: -${info.blur}px;` : 'inset: 0;';
      const size = info.fill === 'contain' ? 'contain' : 'cover';
      return `
/* ── the image layer ──────────────────────────────────────────────────────
   z-index -1 paints it under every in-flow surface but above the canvas
   background. -webkit-app-region must be reset: the layer covers the title
   bar strip, and without this the whole window drag region is punched out. */
#${LAYER_ID} {
  position: fixed; ${spread} z-index: -1; pointer-events: none;
  -webkit-app-region: initial !important;
  background-image: url("${API}/image?v=${info.mtimeMs}");
  background-size: ${size}; background-position: center; background-repeat: no-repeat;
  opacity: ${info.opacity};
  filter: blur(${info.blur}px);
}

/* ── scrim ────────────────────────────────────────────────────────────────
   Between image and UI. Sits above the image (its own stacking context, so it
   does not depend on DOM order) and below the shell. */
#${LAYER_ID}::after {
  content: ""; position: absolute; inset: 0; background: ${info.scrim};
}

/* ── let the image through the shell's surfaces ────────────────────────────
   Re-pointed at a translucent tint of the theme's own base colour instead of
   the keyword "transparent": fully transparent would put body text straight
   onto the picture, which is unreadable at any realistic panel size. */
body[${FLAG}] {
  --dsw-alias-bg-base: color-mix(in srgb, ${base} ${pct}%, transparent);
  --dsw-specific-sidebar-fill: color-mix(in srgb, ${base} ${Math.round(pct * 1.12)}%, transparent);
}

/* Same overrides at higher specificity, because the dark-theme palette sheet is
   appended after this one and would otherwise win the cascade. */
body[data-ds-dark-theme][${FLAG}] {
  --dsw-alias-bg-base: color-mix(in srgb, ${base} ${pct}%, transparent);
  --dsw-specific-sidebar-fill: color-mix(in srgb, ${base} ${Math.round(pct * 1.12)}%, transparent);
}
${blur > 0 ? `
/* ── frosted panels (optional) ─────────────────────────────────────────────
   The surfaces tagged below already sit over the image; a backdrop blur turns
   them into frosted glass instead of a flat tint. Tagged by geometry, because
   the shell's class names are hashed and unstable across versions. */
body[${FLAG}] [${FROST_ATTR}] {
  backdrop-filter: blur(${blur}px);
  -webkit-backdrop-filter: blur(${blur}px);
}
` : ''}`;
    }

    /** Shell surfaces big enough and opaque enough to be worth frosting. */
    function frostCandidates() {
      const viewport = (window.innerWidth || 0) * (window.innerHeight || 0);
      if (!(viewport > 0)) return [];
      const found = [];
      const visit = (node, depth) => {
        for (const child of node.children ?? []) {
          if (typeof child.getBoundingClientRect !== 'function') continue;
          const rect = child.getBoundingClientRect() ?? {};
          const area = (rect.width ?? 0) * (rect.height ?? 0);
          const background = getComputedStyle(child)?.backgroundColor ?? '';
          const opaque = background !== '' && background !== 'transparent' && background !== 'rgba(0, 0, 0, 0)';
          if (area >= viewport * FROST_MIN_AREA && opaque) found.push(child);
          else if (depth < 2) visit(child, depth + 1);
        }
        return found;
      };
      visit(document.body, 0);
      return found.slice(0, FROST_MAX_NODES);
    }

    function clearFrost() {
      for (const node of frosted) {
        try {
          node.removeAttribute(FROST_ATTR);
        } catch {
          /* the node is gone with its subtree; nothing to clean */
        }
      }
      frosted = [];
    }

    function tagFrost(blur, force) {
      const alive = frosted.length > 0 && frosted.every((node) => node.isConnected !== false);
      if (alive && !force) return;
      clearFrost();
      const tagged = [];
      for (const node of frostCandidates()) {
        node.setAttribute(FROST_ATTR, String(blur));
        tagged.push(node);
      }
      frosted = tagged;
    }

    function paint(info) {
      // Remove our sheet FIRST so the computed body colour reflects the host's
      // real (opaque) theme, not the translucent tint our previous sheet applied.
      // This also makes a theme switch pick up the new base colour correctly.
      document.getElementById(STYLE_ID)?.remove();
      const base = shellBaseColor();
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = buildStyle(info, base);
      // The shell is a SPA: it appends/rebuilds stylesheets on navigation, theme
      // switches and panel mounts. Keeping our sheet LAST in <head> is what makes
      // its two --dsw-* token overrides win the cascade; if a newer host sheet is
      // appended after ours, the UI goes opaque again (looks "black").
      document.head.append(style);

      document.getElementById(LAYER_ID)?.remove();
      const layer = document.createElement('div');
      layer.id = LAYER_ID;
      layer.setAttribute('aria-hidden', 'true');
      document.body.prepend(layer);
      document.body.setAttribute(FLAG, '1');

      if (Number(info.backdropBlur) > 0) tagFrost(Number(info.backdropBlur), true);
      else clearFrost();
    }

    /** Cheap integrity check: is everything a working paint needs still in place? */
    function wallpaperHealthy() {
      const style = document.getElementById(STYLE_ID);
      const layer = document.getElementById(LAYER_ID);
      if (!style || !layer) return false;
      if (document.body.getAttribute(FLAG) !== '1') return false;
      // Another module may have appended a stylesheet after ours, overriding the
      // tokens. Move our sheet back to the end of <head> so its overrides win the
      // cascade again. (A thin test DOM has no lastElementChild, so skip there.)
      const head = document.head;
      if (head && typeof head.lastElementChild !== 'undefined' && head.lastElementChild !== style) {
        head.append(style);
      }
      return true;
    }

    /** Re-assert the last good frame when the SPA has knocked ours out. */
    function selfHeal() {
      if (lastGoodInfo === null) return;
      if (wallpaperHealthy()) return;
      try {
        paint(lastGoodInfo);
      } catch (error) {
        console.error('[dsh-wallpaper] failed to repaint the background:', error);
      }
    }

    function erase() {
      document.getElementById(LAYER_ID)?.remove();
      document.getElementById(STYLE_ID)?.remove();
      document.body.removeAttribute(FLAG);
      clearFrost();
      lastGoodInfo = null;
    }

    /* ------------------------------------------------------------ control panel */

    function createPanel(controller) {
      // Capability gate: a real browser element has addEventListener. Our minimal
      // test DOM does not, so the panel simply stays out of those scenarios.
      const probe = document.createElement('div');
      if (typeof probe.addEventListener !== 'function') return null;

      const refs = {};
      const styleEl = el('style', PANEL_STYLE_ID);
      styleEl.textContent = PANEL_CSS;

      const launcher = el('button', LAUNCHER_ID, { type: 'button' });
      launcher.textContent = '🎨';
      launcher.setAttribute('title', '自定义背景设置');

      const panelEl = el('div', PANEL_ID);
      let open = false;
      on(launcher, 'click', () => {
        open = !open;
        if (open) panelEl.setAttribute('data-open', '1');
        else panelEl.removeAttribute('data-open');
      });

      // header + status badge
      const header = el('div', null, { className: 'dsh-wp-header' });
      header.append(el('span', null, { className: 'dsh-wp-title', textContent: '自定义背景' }));
      refs.status = el('span', 'dsh-wp-status');
      header.append(refs.status);
      panelEl.append(header);

      // preview thumbnail
      refs.preview = el('img', 'dsh-wp-preview', { alt: '背景预览' });
      panelEl.append(refs.preview);

      // enabled toggle
      refs.enabled = el('input', 'dsh-wp-enabled', { type: 'checkbox' });
      panelEl.append(row('启用背景', refs.enabled));
      on(refs.enabled, 'change', () => controller.commit({ enabled: refs.enabled.checked }));

      // sliders
      const sliders = [
        ['opacity', '不透明度', 0, 1, 0.01],
        ['blur', '壁纸模糊', 0, 64, 1],
        ['panelAlpha', '面板不透明', 0, 1, 0.01],
        ['backdropBlur', '毛玻璃', 0, 64, 1],
        ['scrimAlpha', '遮罩浓度', 0, 1, 0.01],
      ];
      for (const [key, label, min, max, step] of sliders) {
        const input = el('input', `dsh-wp-${key}`, {
          type: 'range', min: String(min), max: String(max), step: String(step),
        });
        const val = el('span', `dsh-wp-${key}-val`, { className: 'dsh-wp-val' });
        panelEl.append(row(label, input, val));
        refs[key] = input;
        refs[`${key}Val`] = val;
        on(input, 'input', () => {
          const value = Number(input.value);
          val.textContent = formatVal(key, value);
          controller.commit({ [key]: value });
        });
      }

      // fill mode + scrim colour
      refs.fill = el('select', 'dsh-wp-fill');
      refs.fill.append(el('option', null, { value: 'cover', textContent: '铺满 (cover)' }));
      refs.fill.append(el('option', null, { value: 'contain', textContent: '完整 (contain)' }));
      panelEl.append(row('填充方式', refs.fill));
      on(refs.fill, 'change', () => controller.commit({ fill: refs.fill.value }));

      refs.scrimColor = el('input', 'dsh-wp-scrimColor', { type: 'color' });
      panelEl.append(row('遮罩颜色', refs.scrimColor));
      on(refs.scrimColor, 'input', () => controller.commit({ scrimColor: refs.scrimColor.value }));

      // presets (populated from /info)
      panelEl.append(el('div', null, { className: 'dsh-wp-sep' }));
      refs.presets = el('div', 'dsh-wp-presets', { className: 'dsh-wp-presets' });
      panelEl.append(refs.presets);

      // image source: URL import + file upload
      panelEl.append(el('div', null, { className: 'dsh-wp-sep' }));
      refs.url = el('input', 'dsh-wp-url', { type: 'text', placeholder: '粘贴图片 http(s) 链接' });
      refs.urlApply = el('button', 'dsh-wp-url-apply', { type: 'button', className: 'dsh-wp-btn', textContent: '应用链接' });
      panelEl.append(row('图片链接', refs.url, refs.urlApply));
      on(refs.urlApply, 'click', () => {
        const url = String(refs.url.value ?? '').trim();
        if (url === '') {
          refs.message.textContent = '请先粘贴图片链接';
          return;
        }
        void controller.act('/import-url', { url });
      });

      refs.file = el('input', 'dsh-wp-file', { type: 'file', accept: 'image/*' });
      panelEl.append(row('上传图片', refs.file));
      on(refs.file, 'change', () => {
        const file = refs.file.files?.[0];
        if (!file || typeof FileReader === 'undefined') return;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = String(reader.result ?? '');
          const comma = dataUrl.indexOf(',');
          if (comma < 0) return;
          void controller.act('/upload', { dataBase64: dataUrl.slice(comma + 1) });
        };
        reader.readAsDataURL(file);
      });

      // actions
      const actions = el('div', null, { className: 'dsh-wp-actions' });
      refs.useDefault = el('button', 'dsh-wp-default', { type: 'button', className: 'dsh-wp-btn', textContent: '内置默认图' });
      refs.clear = el('button', 'dsh-wp-clear', { type: 'button', className: 'dsh-wp-btn danger', textContent: '清除背景' });
      refs.reset = el('button', 'dsh-wp-reset', { type: 'button', className: 'dsh-wp-btn', textContent: '重置为配置' });
      actions.append(refs.useDefault);
      actions.append(refs.clear);
      actions.append(refs.reset);
      panelEl.append(actions);
      on(refs.useDefault, 'click', () => void controller.act('/config', { useDefault: true }));
      on(refs.clear, 'click', () => void controller.act('/clear', {}));
      on(refs.reset, 'click', () => void controller.act('/config', { reset: true }));

      refs.message = el('div', 'dsh-wp-message');
      panelEl.append(refs.message);
      panelEl.append(el('div', null, {
        className: 'dsh-wp-hint',
        textContent: '面板不透明度：外壳两层都涂，视觉上约等于 1-(1-a)²，调小才看得见图。所有改动即时生效、自动保存。',
      }));

      function showMessage(result) {
        if (result && result.ok === false) refs.message.textContent = `✗ ${result.error ?? '操作失败'}`;
        else refs.message.textContent = '✓ 已应用';
      }

      function buildPresets(presets) {
        const box = refs.presets;
        if (!box) return;
        if (typeof box.replaceChildren === 'function') box.replaceChildren();
        else box.children.length = 0;
        for (const preset of presets) {
          const button = el('button', null, {
            type: 'button', className: 'dsh-wp-btn', textContent: preset.label,
          });
          button.setAttribute('title', preset.hint ?? '');
          on(button, 'click', () => controller.commit(preset.values ?? {}));
          box.append(button);
        }
      }

      function update(info) {
        const status = refs.status;
        if (info.ok === true) {
          status.textContent = '✓ 背景已启用';
          status.setAttribute('data-state', 'ok');
          refs.preview.src = `${API}/image?v=${info.mtimeMs}`;
          refs.preview.setAttribute('data-show', '1');
        } else {
          const reason = info.reason === 'disabled' ? '已关闭'
            : info.reason === 'unconfigured' ? '未配置'
              : info.reason === 'missing' ? '文件缺失'
                : '不可用';
          status.textContent = `✗ ${reason}`;
          status.setAttribute('data-state', 'bad');
          refs.preview.removeAttribute('data-show');
        }
        const focused = document.activeElement;
        const setSlider = (key) => {
          const input = refs[key];
          if (!input) return;
          if (focused === input) return; // do not fight a slider the user is dragging
          const value = info[key];
          if (typeof value !== 'number') return;
          input.value = String(value);
          if (refs[`${key}Val`]) refs[`${key}Val`].textContent = formatVal(key, value);
        };
        for (const key of ['opacity', 'blur', 'panelAlpha', 'backdropBlur', 'scrimAlpha']) setSlider(key);
        if (refs.scrimColor && focused !== refs.scrimColor && typeof info.scrimColor === 'string') {
          refs.scrimColor.value = info.scrimColor;
        }
        if (refs.fill && focused !== refs.fill) refs.fill.value = info.fill === 'contain' ? 'contain' : 'cover';
        if (refs.enabled && focused !== refs.enabled) refs.enabled.checked = info.enabled !== false;
        buildPresets(Array.isArray(info.presets) ? info.presets : []);
      }

      return {
        refs,
        update,
        showMessage,
        mount() {
          document.head.append(styleEl);
          document.body.append(launcher);
          document.body.append(panelEl);
        },
        unmount() {
          styleEl.remove();
          launcher.remove();
          panelEl.remove();
        },
      };
    }

    /* ------------------------------------------------------------------ effect */

    function apply(ctx) {
      ctx.effect(() => {
        let cancelled = false;
        let revision = null;
        let lastNote = null;
        let ticks = 0;

        const note = (message) => {
          if (lastNote === message) return;
          lastNote = message;
          console.warn('[dsh-wallpaper] no usable image:', message);
        };

        const post = async (path, body) => {
          try {
            const response = await fetch(`${API}${path}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body ?? {}),
            });
            if (!response || !response.ok) return { ok: false, error: 'request failed' };
            return await response.json();
          } catch (error) {
            return { ok: false, error: String(error?.message ?? error) };
          }
        };

        // Coalesce rapid slider input into sequential POSTs, then one repaint.
        let sending = false;
        let queued = null;
        const commit = (patch) => {
          queued = { ...(queued ?? {}), ...patch };
          if (sending) return;
          sending = true;
          const drain = async () => {
            while (queued !== null) {
              const body = queued;
              queued = null;
              await post('/config', body);
            }
            sending = false;
            revision = null;
            void tick();
          };
          void drain();
        };

        const act = async (path, body) => {
          const result = await post(path, body);
          activePanel?.showMessage?.(result);
          revision = null;
          void tick();
          return result;
        };

        const tick = async () => {
          if (cancelled) return;
          if (typeof document.visibilityState === 'string' && document.visibilityState === 'hidden') return;
          const info = await requestInfo();
          if (cancelled) return;
          if (info === null) {
            note('the host did not answer /wallpaper/api/info');
            return;
          }
          const next = revisionOf(info);
          if (next === revision) {
            // Even when nothing changed, the SPA may have re-mounted its shell or
            // appended a palette sheet that covered ours. Self-heal every tick.
            selfHeal();
            if (Number(info.backdropBlur) > 0) {
              ticks += 1;
              if (ticks % FROST_RESCAN_TICKS === 0) tagFrost(Number(info.backdropBlur), false);
            }
            return;
          }
          revision = next;
          activePanel?.update?.(info);
          // A missing or unreadable file must not repaint the shell: no flag, no
          // style, no layer. The GUI simply stays stock, and the reason is in the
          // console rather than in a half-applied theme.
          if (info.ok !== true) {
            erase();
            note(info.error ?? 'the host reported no usable image');
            return;
          }
          lastNote = null;
          try {
            paint(info);
            lastGoodInfo = info;
          } catch (error) {
            console.error('[dsh-wallpaper] failed to paint the background:', error);
          }
        };

        // The panel is deliberately isolated: a failure here never affects the
        // wallpaper painting above, and never touches the host's settings shell.
        try {
          activePanel = createPanel({ commit, act });
          activePanel?.mount();
        } catch (error) {
          activePanel = null;
          console.warn('[dsh-wallpaper] control panel unavailable:', error);
        }

        void tick();
        const timer = setInterval(() => void tick(), POLL_MS);

        return () => {
          cancelled = true;
          clearInterval(timer);
          erase();
          try {
            activePanel?.unmount();
          } catch (error) {
            console.warn('[dsh-wallpaper] control panel cleanup failed:', error);
          }
          activePanel = null;
        };
      }, 'dsh-wallpaper: paint');
    }

    return { name, inject, apply };
  },
});
