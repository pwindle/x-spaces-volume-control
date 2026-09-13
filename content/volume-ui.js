/* X Spaces Volume Control - isolated world content script.
 *
 * Responsibilities:
 *   1. Talk to the extension (browser.storage / runtime messages from popup).
 *   2. Read+write localStorage["volume"] on the page's origin.
 *   3. Drive the MAIN world hook (content/volume-hook.js) via CustomEvents.
 *   4. Render the in-page slider inside a shadow root (style isolation) when
 *      we are on a Spaces page or a Spaces dock is present.
 */
(() => {
  "use strict";

  // The popup injects this script on demand when the copy already in the page is
  // missing or stale (the extension was reloaded while the tab stayed open).
  // Without this guard that injection would build a second widget.
  if (window.__xspacesVolumeUiInstalled) return;
  try {
    window.__xspacesVolumeUiInstalled = true;
  } catch (_) {
    /* ignore */
  }

  const api = globalThis.browser ?? globalThis.chrome;

  const STORAGE_KEY = "volume";
  // The widget's slider works in whole percent (1-100); localStorage["volume"]
  // keeps the 0.01-1 value the page's player expects (1% -> 0.01, 100% -> 1).
  const PCT_MIN = 1;
  const PCT_MAX = 100;
  const VOL_MIN = 0.01;
  const VOL_MAX = 1;

  // Where the widget sits: a corner plus a pixel gap from each of the two
  // relevant edges.
  const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"];
  const DEFAULT_CORNER = "bottom-left";
  const DEFAULT_OFFSET = 16;
  const OFFSET_MAX = 999;

  const DEFAULTS = {
    volume: 1,
    showSlider: true,
    corner: DEFAULT_CORNER,
    offsetX: DEFAULT_OFFSET,
    offsetY: DEFAULT_OFFSET
  };

  const clampVolume = (v) => Math.min(VOL_MAX, Math.max(VOL_MIN, v));
  const clampPercent = (p) => Math.min(PCT_MAX, Math.max(PCT_MIN, Math.round(p)));
  const round2 = (v) => Math.round(v * 100) / 100;
  const percentToVolume = (p) => round2(clampPercent(p) / 100);
  const volumeToPercent = (v) => clampPercent(clampVolume(v) * 100);

  const settings = { ...DEFAULTS };
  let hookReady = false;
  let dragging = false;
  let applyTimer = null;

  /* ------------------------------------------------------------------ *
   * localStorage helpers (content scripts share the page's origin)      *
   * ------------------------------------------------------------------ */

  function readStoredVolume() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) return null;
      const v = parseFloat(raw);
      return Number.isFinite(v) ? clampVolume(v) : null;
    } catch (_) {
      return null;
    }
  }

  function writeStoredVolume(value) {
    try {
      localStorage.setItem(STORAGE_KEY, String(round2(clampVolume(value))));
      return true;
    } catch (_) {
      return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * Bridge to the MAIN world hook                                      *
   * ------------------------------------------------------------------ */

  function dispatchToHook(type, payload) {
    window.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify(payload || {}) }));
  }

  function askHook(timeout) {
    return new Promise((resolve) => {
      const reqId = Math.random().toString(36).slice(2);
      const onState = (event) => {
        let data = null;
        try {
          data = typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail;
        } catch (_) {
          data = null;
        }
        if (!data || data.reqId !== reqId) return;
        window.removeEventListener("xspaces:volume-state", onState);
        resolve(data);
      };
      window.addEventListener("xspaces:volume-state", onState);
      dispatchToHook("xspaces:volume-get", { reqId });
      setTimeout(() => {
        window.removeEventListener("xspaces:volume-state", onState);
        resolve(null);
      }, timeout || 400);
    });
  }

  function setHookVolume(value, opts) {
    dispatchToHook("xspaces:volume-set", { value: clampVolume(value), ...(opts || {}) });
  }

  /* ------------------------------------------------------------------ *
   * Shared "apply" used by popup, in-page slider and startup           *
   * ------------------------------------------------------------------ */

  async function applyVolume(value, opts) {
    const options = opts || {};
    const next = clampVolume(value);
    settings.volume = next;

    const tasks = [api.storage.local.set({ volume: next })];
    if (options.persistToPage !== false) {
      writeStoredVolume(next);
    }
    // Live application (no reload).
    if (options.live !== false) {
      setHookVolume(next);
    }
    await Promise.all(tasks);

    // A newer value may have arrived while this write was in flight (a drag
    // fires input events faster than storage settles). Never let a stale write
    // snap the UI back to an older level.
    if (round2(settings.volume) === round2(next)) {
      updateWidgetValue(next);
    }
    return next;
  }

  // Slider drags fire one input event per pixel. The UI is updated
  // synchronously by the caller - doing it inline rather than after an await is
  // what stops the handle jumping back mid-drag - and only the persistence is
  // coalesced, so a burst of drags causes a single storage write.
  function queueApply(volume) {
    clearTimeout(applyTimer);
    applyTimer = setTimeout(() => {
      applyVolume(volume, { persistToPage: true });
    }, 60);
  }

  async function setSliderVisible(visible) {
    settings.showSlider = !!visible;
    await api.storage.local.set({ showSlider: settings.showSlider });
    refreshWidgetVisibility();
    return settings.showSlider;
  }

  /* ------------------------------------------------------------------ *
   * In-page slider (shadow DOM so X's CSS can't touch it)              *
   * ------------------------------------------------------------------ */

  const HOST_ID = "xspaces-volume-host";
  let host = null;
  let ui = null;

  const WIDGET_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    .panel {
      position: fixed; left: 16px; bottom: 16px; z-index: 2147483647;
      width: 232px; padding: 10px 12px 12px;
      background: rgba(17, 20, 24, 0.92);
      -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 14px; color: #eef3f4;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
      font-size: 12px; line-height: 1.2;
      user-select: none;
    }
    .panel.collapsed { width: auto; padding: 6px; border-radius: 999px; }
    .panel.collapsed .body { display: none; }
    .head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .title { flex: 1; font-weight: 600; letter-spacing: 0.2px; }
    .pct { font-variant-numeric: tabular-nums; color: #8ecdf7; font-weight: 600; }
    .icon-btn {
      border: 0; background: rgba(255,255,255,0.08); color: inherit;
      width: 22px; height: 22px; border-radius: 6px; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 12px; padding: 0;
    }
    .icon-btn:hover { background: rgba(255,255,255,0.18); }
    input[type="range"] {
      -webkit-appearance: none; appearance: none;
      width: 100%; height: 18px; margin: 0 0 8px; background: transparent; cursor: pointer;
    }
    input[type="range"]::-webkit-slider-runnable-track {
      height: 6px; border-radius: 999px; background: rgba(255,255,255,0.18);
    }
    input[type="range"]::-moz-range-track {
      height: 6px; border-radius: 999px; background: rgba(255,255,255,0.18);
    }
    input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none; margin-top: -5px;
      width: 16px; height: 16px; border-radius: 50%;
      background: #1d9bf0; border: 2px solid #fff;
    }
    input[type="range"]::-moz-range-thumb {
      width: 14px; height: 14px; border-radius: 50%;
      background: #1d9bf0; border: 2px solid #fff;
    }
  `;

  function buildWidget() {
    if (host) return;

    host = document.createElement("div");
    host.id = HOST_ID;
    // The host itself must not affect the page layout.
    host.style.cssText = "all: initial; position: static;";
    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = WIDGET_CSS;

    const panel = document.createElement("div");
    panel.className = "panel";
    // Static markup only (no interpolated values), so this stays a plain
    // constant string; the range bounds/value are set on the element below.
    panel.innerHTML = `
      <div class="head">
        <span class="title">Spaces volume</span>
        <span class="pct">100%</span>
        <button class="icon-btn" data-act="collapse" title="Collapse">&#9662;</button>
      </div>
      <div class="body">
        <input class="range" type="range" min="1" max="100" step="1" value="100">
      </div>
    `;

    shadow.append(style, panel);

    ui = {
      panel,
      range: panel.querySelector(".range"),
      pct: panel.querySelector(".pct"),
      collapsed: false
    };

    ui.range.min = String(PCT_MIN);
    ui.range.max = String(PCT_MAX);
    ui.range.step = "1";
    ui.range.value = String(volumeToPercent(settings.volume));

    ui.range.addEventListener("input", () => {
      // Update the level and the readout synchronously so nothing can
      // overwrite the handle while the drag is still in progress.
      const volume = percentToVolume(parseFloat(ui.range.value));
      settings.volume = volume;
      updateWidgetValue(volume);
      queueApply(volume);
    });
    ui.range.addEventListener("pointerdown", () => {
      dragging = true;
    });
    window.addEventListener("pointerup", () => {
      dragging = false;
    });

    panel.addEventListener("click", (event) => {
      const target = event.target && event.target.closest ? event.target.closest("[data-act]") : null;
      if (!target) return;
      if (target.dataset.act === "collapse") {
        ui.collapsed = !ui.collapsed;
        panel.classList.toggle("collapsed", ui.collapsed);
      }
    });

    applyWidgetPosition();
    (document.body || document.documentElement).appendChild(host);
    refreshWidgetVisibility();
  }

  function updateWidgetValue(volume) {
    if (!ui) return;
    const pct = volumeToPercent(volume);
    if (!dragging) ui.range.value = String(pct);
    ui.pct.textContent = `${pct}%`;
  }

  const clampOffset = (v) =>
    Math.min(OFFSET_MAX, Math.max(0, Math.round(Number.isFinite(v) ? v : DEFAULT_OFFSET)));

  // Only touch a style when it actually changes: this runs on every mutation
  // observer tick, and needless writes force a style recalculation.
  function setEdge(style, prop, value) {
    if (style[prop] !== value) style[prop] = value;
  }

  // The panel is positioned with inline offsets rather than fixed CSS so both
  // the corner and the gaps are configurable. All four edges are written every
  // time ('auto' for the two the chosen corner does not use) - leaving a stale
  // `left` alongside a new `right` would stretch the panel between them.
  function applyWidgetPosition() {
    if (!ui || !ui.panel) return;
    const corner = CORNERS.indexOf(settings.corner) >= 0 ? settings.corner : DEFAULT_CORNER;
    const x = clampOffset(settings.offsetX);
    const y = clampOffset(settings.offsetY);
    const style = ui.panel.style;
    setEdge(style, "left", corner.endsWith("left") ? `${x}px` : "auto");
    setEdge(style, "right", corner.endsWith("right") ? `${x}px` : "auto");
    setEdge(style, "top", corner.startsWith("top") ? `${y}px` : "auto");
    setEdge(style, "bottom", corner.startsWith("bottom") ? `${y}px` : "auto");
  }

  async function setPosition(next) {
    if (CORNERS.indexOf(next.corner) >= 0) settings.corner = next.corner;
    settings.offsetX = clampOffset(next.offsetX);
    settings.offsetY = clampOffset(next.offsetY);
    await api.storage.local.set({
      corner: settings.corner,
      offsetX: settings.offsetX,
      offsetY: settings.offsetY
    });
    applyWidgetPosition();
    return {
      corner: settings.corner,
      offsetX: settings.offsetX,
      offsetY: settings.offsetY
    };
  }

  function isSpacesContext() {
    try {
      if (/\/i\/spaces\//.test(location.pathname)) return true;
      return !!document.querySelector(
        '[data-testid="SpaceDockExpanded"], [data-testid="SpaceDock"], [data-testid="SpaceDockButton"]'
      );
    } catch (_) {
      return false;
    }
  }

  function refreshWidgetVisibility() {
    if (!host) return;
    const show = settings.showSlider && isSpacesContext();
    host.style.display = show ? "" : "none";
    if (show) {
      applyWidgetPosition();
      updateWidgetValue(settings.volume);
    }
  }

  /* ------------------------------------------------------------------ *
   * Popup messaging                                                    *
   * ------------------------------------------------------------------ */

  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      switch (message && message.type) {
        case "xs:get": {
          const hook = await askHook();
          let media = 0;
          try {
            media = document.querySelectorAll("audio,video").length;
          } catch (_) {
            media = 0;
          }
          sendResponse({
            ok: true,
            supported: true,
            hook: !!hook,
            value: settings.volume,
            stored: readStoredVolume(),
            showSlider: settings.showSlider,
            media: hook ? hook.media : media,
            elements: hook ? hook.elements : media,
            interference: hook ? hook.interference : null
          });
          break;
        }
        case "xs:set": {
          const value = await applyVolume(message.value, {
            live: message.live !== false,
            persistToPage: message.persistToPage !== false
          });
          sendResponse({ ok: true, value });
          break;
        }
        case "xs:showSlider": {
          const showSlider = await setSliderVisible(message.value);
          sendResponse({ ok: true, showSlider });
          break;
        }
        case "xs:position": {
          const position = await setPosition(message);
          sendResponse({ ok: true, ...position });
          break;
        }
        default:
          sendResponse({ ok: false, error: "unknown message" });
      }
    })();
    return true; // keep the message channel open for the async response
  });

  /* ------------------------------------------------------------------ *
   * Startup                                                            *
   * ------------------------------------------------------------------ */

  (async () => {
    const stored = await api.storage.local.get(DEFAULTS);
    settings.volume = clampVolume(
      typeof stored.volume === "number" ? stored.volume : DEFAULTS.volume
    );
    settings.showSlider = stored.showSlider !== false;
    settings.corner = CORNERS.indexOf(stored.corner) >= 0 ? stored.corner : DEFAULT_CORNER;
    settings.offsetX = clampOffset(stored.offsetX);
    settings.offsetY = clampOffset(stored.offsetY);

    // The page's own value wins, so we never fight the native UI.
    const pageValue = readStoredVolume();
    if (pageValue !== null) settings.volume = pageValue;

    // Wait for the hook (document_start) to be reachable, then push state.
    for (let attempt = 0; attempt < 6 && !hookReady; attempt++) {
      // eslint-disable-next-line no-await-in-loop
      hookReady = !!(await askHook());
      if (!hookReady) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 120));
      }
    }
    setHookVolume(settings.volume);

    buildWidget();
    updateWidgetValue(settings.volume);
    refreshWidgetVisibility();

    const observer = new MutationObserver(() => refreshWidgetVisibility());
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // Follow deliberate changes made in another tab/window. "storage" only
    // fires for other documents, so this is the cross-tab path; drift written
    // by this tab's own page script is handled by the poll below.
    window.addEventListener("storage", (event) => {
      if (event.key !== STORAGE_KEY || event.newValue === null) return;
      const v = parseFloat(event.newValue);
      if (Number.isFinite(v)) {
        settings.volume = clampVolume(v);
        updateWidgetValue(settings.volume);
      }
    });

    // Poll for drift in localStorage["volume"].
    //
    // The level the user picked is authoritative. X's own player re-persists
    // its volume periodically, and it has no idea we changed anything - so it
    // happily writes its old value back. Adopting that (which is what this used
    // to do) yanked the slider back to where it started a second or two after
    // the user moved it, and re-pushed the old level to the hook so the audio
    // reverted too. Instead: if the page's value drifts from ours, put ours
    // back.
    //
    // A genuine change from another tab/window is still picked up - that
    // arrives as a "storage" event, handled above.
    setInterval(() => {
      if (dragging) return;
      const stored = readStoredVolume();
      if (stored === null) return;
      if (round2(stored) === round2(settings.volume)) return;

      writeStoredVolume(settings.volume);
      setHookVolume(settings.volume);
      updateWidgetValue(settings.volume);
    }, 2000);
  })();
})();
