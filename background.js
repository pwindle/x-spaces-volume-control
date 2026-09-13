/* X Spaces Volume Control - background event page.
 *
 * Very small: it only seeds the default settings the first time the
 * extension is installed/updated. All real work happens in the content
 * scripts (page hook + in-page slider) and in the popup.
 */
"use strict";

const api = globalThis.browser ?? globalThis.chrome;

const DEFAULTS = {
  volume: 1, // master volume as the stored 0.01 .. 1 fraction (UI shows 1-100%)
  showSlider: true, // show the injected in-page slider
  corner: "bottom-left", // which corner the in-page slider sits in
  offsetX: 16, // px gap from the left/right edge
  offsetY: 16 // px gap from the top/bottom edge
};

api.runtime.onInstalled.addListener(() => {
  // get() fills in any missing keys with the defaults above.
  api.storage.local.get(DEFAULTS).then((stored) => api.storage.local.set(stored));
});
