/* X Spaces Volume Control - MAIN world audio hook.
 *
 * Injected at document_start, *before* any page script runs, so the patches
 * below are in place when the Spaces player initialises. Because this file
 * runs in the page's own JS context it can wrap HTMLMediaElement.volume, which
 * is what lets us change the level without reloading the tab.
 *
 * It is "dumb" on purpose: it never talks to the extension APIs (MAIN world
 * scripts have no access to them). The isolated-world script in
 * content/volume-ui.js drives it with DOM CustomEvents carrying JSON strings
 * (string detail survives the isolated <-> page world boundary everywhere).
 *
 * Events it listens to (dispatched on window):
 *   xspaces:volume-set    detail: JSON {value?}
 *   xspaces:volume-get    detail: JSON {reqId}
 *
 * Event it dispatches (on window):
 *   xspaces:volume-state  detail: JSON {reqId, hook:true, value, stored, ...}
 */
(() => {
  "use strict";

  if (window.__xspacesVolumeHook) return;

  const STORAGE_KEY = "volume";
  const MIN = 0.01;
  const MAX = 1;
  const SWEEP_MS = 1500;

  const clampVolume = (v) => Math.min(MAX, Math.max(MIN, v));
  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  const state = {
    master: 1 // multiplier applied on top of whatever the page asks for
  };

  /* ------------------------------------------------------------------ *
   * localStorage ("volume") - read by the page's own player on startup  *
   * ------------------------------------------------------------------ */

  function readStored() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) return null;
      const v = parseFloat(raw);
      return Number.isFinite(v) ? clampVolume(v) : null;
    } catch (_) {
      return null;
    }
  }

  function writeStored(value) {
    try {
      localStorage.setItem(STORAGE_KEY, String(Math.round(value * 100) / 100));
      return true;
    } catch (_) {
      return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * HTMLMediaElement.volume                                            *
   *                                                                    *
   * We keep the volume the *page* intended in a WeakMap and always     *
   * recompute from it, so a page that reads .volume back and writes it  *
   * again cannot compound the multiplier.                               *
   * ------------------------------------------------------------------ */

  const intent = new WeakMap(); // element -> volume the page asked for
  const applied = new WeakMap(); // element -> volume we actually set
  const nativeVolume = Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    "volume"
  );

  function effectiveFor(el) {
    const base = intent.has(el) ? intent.get(el) : 1;
    return clamp01(base * state.master);
  }

  function setNative(el, value) {
    if (nativeVolume && nativeVolume.set) {
      nativeVolume.set.call(el, value);
    } else {
      el.volume = value;
    }
  }

  function applyToElement(el) {
    const eff = effectiveFor(el);
    if (applied.get(el) === eff) return;
    applied.set(el, eff);
    try {
      setNative(el, eff);
    } catch (_) {
      /* element gone / cross-origin media - ignore */
    }
  }

  // A second script patching the same property is a real possibility (another
  // volume extension), and it produces confusing behaviour: two layers of
  // scaling, or another script overwriting the level a moment later. Detect and
  // report it rather than leaving the user to guess.
  const interference = {
    // Someone had already wrapped .volume before this script ran.
    patchedBefore:
      !!nativeVolume &&
      typeof nativeVolume.set === "function" &&
      String(nativeVolume.set).indexOf("native code") === -1,
    // Someone wrapped .volume again after we installed our setter.
    replaced: false
  };

  function ourVolumeSetter(value) {
    // Track only: applyToElement would write a redundant (and temporarily
    // wrong) volume before this setter has computed the real one.
    trackElement(this);
    let base = intent.has(this) ? intent.get(this) : value;
    // If the incoming value is exactly what we last applied, the page is
    // just echoing our own value back - don't treat it as a new intent.
    if (value !== applied.get(this)) base = value;
    intent.set(this, base);
    const eff = clamp01(base * state.master);
    applied.set(this, eff);
    try {
      nativeVolume.set.call(this, eff);
    } catch (_) {
      /* ignore */
    }
  }

  function checkVolumeStillOurs() {
    try {
      const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume");
      if (desc && desc.set && desc.set !== ourVolumeSetter) interference.replaced = true;
    } catch (_) {
      /* ignore */
    }
  }

  if (nativeVolume && nativeVolume.set && nativeVolume.get) {
    Object.defineProperty(HTMLMediaElement.prototype, "volume", {
      configurable: true,
      enumerable: nativeVolume.enumerable,
      get() {
        return nativeVolume.get.call(this);
      },
      set: ourVolumeSetter
    });
  }

  /* ------------------------------------------------------------------ *
   * Tracking media elements                                            *
   *                                                                    *
   * Discovery must NOT depend on querySelectorAll. X's Spaces player    *
   * (like many players) creates its media element and never appends it  *
   * to the document, and a detached element is invisible to a DOM scan  *
   * - so a level change would silently never reach the one element that *
   * matters, and would only "stick" later when something else happened  *
   * to write .volume again. Instead every element is registered when it *
   * is created, first played, or first written to, and applied to       *
   * directly from that set from then on.                                *
   * ------------------------------------------------------------------ */

  const knownElements = new Set();

  // Elements inside shadow roots are invisible to querySelectorAll too, so
  // every root is registered as it is created (attachShadow is patched before
  // any page script runs).
  const shadowRoots = new Set();

  if (typeof Element.prototype.attachShadow === "function") {
    const origAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function patchedAttachShadow(init) {
      const root = origAttachShadow.call(this, init);
      try {
        shadowRoots.add(root);
      } catch (_) {
        /* ignore */
      }
      return root;
    };
  }

  function isMediaElement(node) {
    try {
      return !!node && (node.tagName === "AUDIO" || node.tagName === "VIDEO");
    } catch (_) {
      return false;
    }
  }

  function trackElement(node) {
    if (isMediaElement(node)) knownElements.add(node);
    return node;
  }

  function registerElement(node) {
    if (!isMediaElement(node)) return node;
    knownElements.add(node);
    applyToElement(node);
    return node;
  }

  // Drop elements that are gone AND silent. A detached element that is still
  // playing stays tracked: it is still audible and must keep receiving level
  // changes (players detach their element during rebuilds while audio plays).
  function pruneElements() {
    knownElements.forEach((el) => {
      try {
        if (!el.isConnected && (el.paused || el.ended)) knownElements.delete(el);
      } catch (_) {
        /* ignore */
      }
    });
  }

  function sweepRoot(root) {
    if (!root || typeof root.querySelectorAll !== "function") return;
    root.querySelectorAll("audio,video").forEach(registerElement);
  }

  function sweep() {
    sweepRoot(document);
    shadowRoots.forEach(sweepRoot);
  }

  // new Audio() and document.createElement("video") never go through play(),
  // so tag media elements at creation - patched before any page script runs.
  (function patchElementCreation() {
    const docProto = window.Document && window.Document.prototype;
    if (docProto) {
      const wrap = (name) => {
        const orig = docProto[name];
        if (typeof orig !== "function") return;
        docProto[name] = function patchedCreate(tag, ...rest) {
          return registerElement(orig.call(this, tag, ...rest));
        };
      };
      wrap("createElement");
      wrap("createElementNS");
    }

    const AudioCtor = window.Audio;
    if (typeof AudioCtor === "function") {
      const PatchedAudio = function PatchedAudio(src) {
        const el = arguments.length > 0 ? new AudioCtor(src) : new AudioCtor();
        return registerElement(el);
      };
      PatchedAudio.prototype = AudioCtor.prototype;
      try {
        Object.setPrototypeOf(PatchedAudio, AudioCtor);
        window.Audio = PatchedAudio;
      } catch (_) {
        /* ignore */
      }
    }
  })();

  // Elements inserted via innerHTML/insertAdjacentHTML never pass through the
  // patched createElement, so watch the tree as well.
  (function watchForInjectedMedia() {
    if (typeof MutationObserver !== "function") return;
    try {
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          const added = mutation.addedNodes;
          if (!added) continue;
          for (let i = 0; i < added.length; i++) {
            const node = added[i];
            if (!node || node.nodeType !== 1) continue;
            if (isMediaElement(node)) {
              registerElement(node);
            } else if (node.querySelectorAll) {
              try {
                node.querySelectorAll("audio,video").forEach(registerElement);
              } catch (_) {
                /* ignore */
              }
            }
          }
        }
      });
      const start = () => {
        try {
          observer.observe(document.documentElement || document, {
            childList: true,
            subtree: true
          });
        } catch (_) {
          /* ignore */
        }
      };
      if (document.documentElement) start();
      else document.addEventListener("DOMContentLoaded", start, { once: true });
    } catch (_) {
      /* ignore */
    }
  })();

  // Catch elements that are created but never have .volume set by the page
  // (they would otherwise stay at the native default of 1).
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function patchedPlay() {
    registerElement(this);
    return origPlay.apply(this, arguments);
  };

  /* ------------------------------------------------------------------ *
   * No Web Audio support                                               *
   *                                                                    *
   * An earlier version scaled GainNode `gain` AudioParams (both the      *
   * `.value` setter and the scheduling methods). It was dropped after    *
   * testing on the real player: it made no audible difference, and       *
   * patching a shared AudioParam graph risks affecting unrelated audio   *
   * such as local mic processing. The audible path is the media element, *
   * which is handled above.                                             *
   * ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ *
   * Applying / re-applying the master level                            *
   * ------------------------------------------------------------------ */

  function applyAll() {
    // Pick up anything already in the DOM that we have not seen yet, then push
    // the level to every tracked element - including detached ones, which the
    // DOM scan can never find.
    sweep();
    knownElements.forEach(applyToElement);
    pruneElements();
  }

  function setMaster(value, opts) {
    const next = clampVolume(value);
    const changed = next !== state.master;
    state.master = next;
    if (opts && opts.persist) writeStored(next);
    if (changed || (opts && opts.force)) applyAll();
    return state.master;
  }

  /* ------------------------------------------------------------------ *
   * Bridge to the isolated-world content script                         *
   * ------------------------------------------------------------------ */

  function parse(detail) {
    if (typeof detail === "string") {
      try {
        return JSON.parse(detail);
      } catch (_) {
        return null;
      }
    }
    return detail && typeof detail === "object" ? detail : null;
  }

  function emit(payload) {
    window.dispatchEvent(
      new CustomEvent("xspaces:volume-state", { detail: JSON.stringify(payload) })
    );
  }

  window.addEventListener("xspaces:volume-set", (event) => {
    const msg = parse(event.detail);
    if (!msg) return;
    if (typeof msg.value === "number") setMaster(msg.value, { persist: true, force: true });
  });

  window.addEventListener("xspaces:volume-get", (event) => {
    const msg = parse(event.detail) || {};
    let media = 0;
    try {
      media = document.querySelectorAll("audio,video").length;
    } catch (_) {
      media = 0;
    }
    emit({
      reqId: msg.reqId || null,
      hook: true,
      value: state.master,
      stored: readStored(),
      interference: { patchedBefore: interference.patchedBefore, replaced: interference.replaced },
      media,
      // Tracked elements include detached players the DOM scan cannot see.
      elements: knownElements.size,
      readyState: document.readyState
    });
  });

  // Initial value: whatever the page itself last stored. If nothing is
  // stored we leave playback untouched (master = 1).
  const stored = readStored();
  if (stored !== null) state.master = stored;

  window.__xspacesVolumeHook = {
    get value() {
      return state.master;
    },
    set: (v, opts) => setMaster(v, opts),
    applyAll
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyAll, { once: true });
  } else {
    applyAll();
  }
  window.addEventListener("load", applyAll, { once: true });

  // Keep element-based and gain-based levels honest (new elements, page-side
  // resets, fade ramps) without touching anything when we are at 100%.
  setInterval(() => {
    checkVolumeStillOurs();
    if (state.master !== 1) applyAll();
  }, SWEEP_MS);
})();
