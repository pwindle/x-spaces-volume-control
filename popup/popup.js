/* X Spaces Volume Control - popup logic.
 *
 * The popup is the "remote control": it persists the chosen level in
 * browser.storage, then asks the content script on the active tab to write
 * localStorage.volume and apply the level live. If no content script is
 * listening yet (e.g. the extension was just reloaded while the tab stayed
 * open) it injects the scripts on demand.
 */
"use strict";

const api = globalThis.browser ?? globalThis.chrome;

// The sliders work in whole percent (1-100) because that reads more naturally
// than fractions. localStorage["volume"] still stores the 0.01-1 value the
// page's player expects, so 1% -> 0.01 and 100% -> 1.
const PCT_MIN = 1;
const PCT_MAX = 100;
const VOL_MIN = 0.01;
const VOL_MAX = 1;

// Where the in-page slider sits: a corner plus a gap in pixels from each of the
// two relevant edges.
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

const el = {
  slider: document.getElementById("slider"),
  number: document.getElementById("number"),
  readout: document.getElementById("readout"),
  status: document.getElementById("status"),
  detail: document.getElementById("detail"),
  showslider: document.getElementById("showslider"),
  corner: document.getElementById("corner"),
  offsetx: document.getElementById("offsetx"),
  offsety: document.getElementById("offsety"),
  offsetxLabel: document.getElementById("offsetx-label"),
  offsetyLabel: document.getElementById("offsety-label")
};

let tab = null;
let supported = false;

const clampVolume = (v) => Math.min(VOL_MAX, Math.max(VOL_MIN, v));
const clampPercent = (p) => Math.min(PCT_MAX, Math.max(PCT_MIN, Math.round(p)));
const round2 = (v) => Math.round(v * 100) / 100;
const percentToVolume = (p) => round2(clampPercent(p) / 100);
const volumeToPercent = (v) => clampPercent(clampVolume(v) * 100);

const clampOffset = (v) =>
  Math.min(OFFSET_MAX, Math.max(0, Math.round(Number.isFinite(v) ? v : DEFAULT_OFFSET)));

// The labels name the two edges the corner actually uses, so "From left"
// becomes "From right" when the widget is moved to a right-hand corner.
function updateOffsetLabels(corner) {
  el.offsetxLabel.textContent = corner.endsWith("right") ? "From right" : "From left";
  el.offsetyLabel.textContent = corner.startsWith("top") ? "From top" : "From bottom";
}

function showPosition(position) {
  el.corner.value = position.corner;
  el.offsetx.value = String(position.offsetX);
  el.offsety.value = String(position.offsetY);
  updateOffsetLabels(position.corner);
}

// Read the controls, clamp them, and reflect the clamped values back so what is
// stored is always what the inputs show.
function readPositionControls() {
  return {
    corner: CORNERS.indexOf(el.corner.value) >= 0 ? el.corner.value : DEFAULT_CORNER,
    offsetX: clampOffset(parseFloat(el.offsetx.value)),
    offsetY: clampOffset(parseFloat(el.offsety.value))
  };
}

async function pushPosition() {
  const position = readPositionControls();
  showPosition(position);
  await api.storage.local.set(position);
  const res = await sendToTabWithInject({ type: "xs:position", ...position });
  if (res && res.ok) {
    el.detail.textContent =
      `in-page slider: ${position.corner.replace("-", " ")} · ` +
      `${position.offsetX}px / ${position.offsetY}px`;
  } else if (supported) {
    el.detail.textContent = "Saved. Reload the x.com tab to move the in-page slider.";
  }
}

function setStatus(text, kind) {
  el.status.textContent = text;
  el.status.className = "badge" + (kind ? " " + kind : "");
}

function render(volume, opts) {
  const pct = volumeToPercent(volume);
  if (!opts || !opts.skipSlider) el.slider.value = String(pct);
  if (!opts || !opts.skipNumber) el.number.value = String(pct);
  el.readout.textContent = `${pct}%`;
  el.slider.style.setProperty("--fill", `${((pct - PCT_MIN) / (PCT_MAX - PCT_MIN)) * 100}%`);
}

async function getActiveTab() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0] : null;
}

function isSupportedUrl(url) {
  return /^https?:\/\/(x|twitter)\.com\//i.test(url || "");
}

async function sendToTab(message) {
  if (!tab || tab.id === undefined) return null;
  try {
    const res = await api.tabs.sendMessage(tab.id, message);
    // A content script left over from an older version of the extension answers
    // unknown messages rather than throwing. Treat that as "not there", so the
    // caller can inject the current copy instead of failing silently.
    if (res && res.ok === false && res.error === "unknown message") return null;
    return res;
  } catch (_) {
    return null;
  }
}

// Send a message, injecting the current content script first if the page has no
// live copy. This is what lets settings changes take effect without a tab
// reload after the extension itself is reloaded.
async function sendToTabWithInject(message) {
  const first = await sendToTab(message);
  if (first || !supported) return first;
  if (!(await ensureContentScript())) return null;
  await new Promise((r) => setTimeout(r, 150));
  return sendToTab(message);
}

async function ensureContentScript() {
  if (!tab || tab.id === undefined) return false;
  // The hook is MAIN world (needs to patch the page's audio APIs); the UI
  // script is the isolated-world bridge the popup talks to.
  try {
    await api.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["content/volume-hook.js"],
      world: "MAIN"
    });
  } catch (_) {
    /* hook may already be present, or MAIN world unsupported */
  }
  try {
    await api.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content/volume-ui.js"]
    });
  } catch (_) {
    return false;
  }
  return true;
}

async function askState() {
  return sendToTabWithInject({ type: "xs:get" });
}

/* ---------------------------------------------------------------------- *
 * Event wiring                                                           *
 * ---------------------------------------------------------------------- */

let applyTimer = null;

function queueLiveApply(volume) {
  const value = clampVolume(volume);
  clearTimeout(applyTimer);
  applyTimer = setTimeout(async () => {
    await api.storage.local.set({ volume: value });
    const res = await sendToTab({
      type: "xs:set",
      value,
      live: true,
      persistToPage: true
    });
    if (res && res.ok) {
      el.detail.textContent = `${volumeToPercent(value)}% · localStorage.volume = ${round2(value)} (applied live)`;
    }
  }, 90);
}

function onSliderInput() {
  const volume = percentToVolume(parseFloat(el.slider.value));
  render(volume, { skipSlider: true });
  queueLiveApply(volume);
}

el.slider.addEventListener("input", onSliderInput);

el.number.addEventListener("change", () => {
  const volume = percentToVolume(parseFloat(el.number.value) || PCT_MAX);
  render(volume);
  queueLiveApply(volume);
});

el.showslider.addEventListener("change", async () => {
  await api.storage.local.set({ showSlider: el.showslider.checked });
  const res = await sendToTabWithInject({ type: "xs:showSlider", value: el.showslider.checked });
  if (res && res.ok) {
    el.detail.textContent = el.showslider.checked
      ? "In-page slider enabled on Spaces pages."
      : "In-page slider hidden.";
  } else if (supported) {
    el.detail.textContent = "Saved. Reload the x.com tab to apply.";
  }
});

el.corner.addEventListener("change", pushPosition);
el.offsetx.addEventListener("change", pushPosition);
el.offsety.addEventListener("change", pushPosition);

/* ---------------------------------------------------------------------- *
 * Init                                                                   *
 * ---------------------------------------------------------------------- */

(async () => {
  const stored = await api.storage.local.get(DEFAULTS);
  render(stored.volume);
  el.showslider.checked = stored.showSlider !== false;
  showPosition({
    corner: CORNERS.indexOf(stored.corner) >= 0 ? stored.corner : DEFAULT_CORNER,
    offsetX: clampOffset(stored.offsetX),
    offsetY: clampOffset(stored.offsetY)
  });

  tab = await getActiveTab();
  supported = isSupportedUrl(tab && tab.url);

  if (!supported) {
    setStatus("not an X tab");
    el.detail.textContent = "Open x.com or twitter.com to control a live space.";
    return;
  }

  const state = await askState();
  if (!state) {
    setStatus("not loaded", "warn");
    el.detail.textContent = "Could not reach the page. Reload the tab once.";
    return;
  }

  setStatus(state.hook ? "live control ready" : "hook missing", state.hook ? "ok" : "warn");
  render(state.value);
  el.showslider.checked = state.showSlider !== false;
  el.detail.textContent = [
    `tracked media: ${state.elements === undefined ? state.media : state.elements}`,
    state.stored === null ? "localStorage.volume not set yet" : `localStorage.volume = ${state.stored}`
  ].join(" · ");

  // Another script patching media volume means two things are fighting over it.
  const clash = state.interference && (state.interference.patchedBefore || state.interference.replaced);
  if (clash) {
    setStatus("volume conflict", "warn");
    el.detail.textContent =
      "Another script is also patching media volume on this page (likely a second " +
      "Spaces-volume extension). Disable it - the two will fight over the level.";
  }
})();
