/* Light / dark theme switch.
 *
 * Loaded SYNCHRONOUSLY from <head> on every page (index + login) so the stored
 * choice is stamped on <html> BEFORE first paint — a deferred/end-of-body
 * script would flash the dark default first. The CSP is `script-src 'self'`,
 * so this cannot be an inline <script>; a same-origin file is the only
 * pre-paint hook available.
 *
 * Model:
 *   stored preference  "dark" | "light" | "system"  (localStorage, per browser)
 *   resolved theme     "dark" | "light"             (what <html> actually gets)
 * "system" follows the OS via prefers-color-scheme and keeps following it live.
 * The DARK theme is the default for an unset/corrupt/unknown preference, so a
 * fresh browser (or a wiped localStorage) renders exactly as it always has.
 *
 * The pure core (THEME_KEY, themeFromStored, nextTheme) is unit-tested in
 * tests/test_snap.mjs — same PURE-CORE-then-DOM layout as the other modules.
 */
var THEME_KEY = "dma.theme";
var THEME_VALUES = ["dark", "light", "system"];

/* Resolve a STORED preference (any junk included) to the theme to render.
 * `systemPrefersLight` is the media-query result, passed in so the core stays
 * DOM-free and testable. Anything unrecognized resolves to "dark". */
function themeFromStored(stored, systemPrefersLight) {
  if (stored === "light") return "light";
  if (stored === "dark") return "dark";
  if (stored === "system") return systemPrefersLight ? "light" : "dark";
  return "dark";
}

/* The toggle is a simple two-state flip on the RESOLVED theme: whatever you
 * are looking at, the button gives you the other one. Choosing explicitly also
 * ends "system" following — an explicit click should stick even if the OS
 * later changes (users flip to light for a screenshot, not to opt into the
 * OS schedule). */
function nextTheme(resolved) {
  return resolved === "light" ? "dark" : "light";
}

(function () {
  var root = document.documentElement;

  function systemPrefersLight() {
    try {
      return window.matchMedia("(prefers-color-scheme: light)").matches;
    } catch (e) {
      return false; // no matchMedia -> keep the dark default
    }
  }

  function readStored() {
    try {
      return localStorage.getItem(THEME_KEY);
    } catch (e) {
      return null; // private mode / storage disabled -> default theme
    }
  }

  /* Paint the resolved theme. data-theme is ALWAYS set explicitly (never
   * removed) so the CSS never has to guess, and the browser UI hint
   * (theme-color) tracks the surface color for mobile address bars. */
  function apply(resolved) {
    root.setAttribute("data-theme", resolved);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", resolved === "light" ? "#eef0f7" : "#0a0b10");
    return resolved;
  }

  var stored = readStored();
  var resolved = apply(themeFromStored(stored, systemPrefersLight()));

  /* Live OS changes only matter while the preference is "system". */
  try {
    var mq = window.matchMedia("(prefers-color-scheme: light)");
    var onChange = function () {
      if (readStored() === "system") {
        window.Theme.resolved = apply(themeFromStored("system", mq.matches));
        window.dispatchEvent(new CustomEvent("themechange", {
          detail: { theme: window.Theme.resolved },
        }));
      }
    };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange); // older Safari
  } catch (e) {}

  /* Public surface consumed by app.js (the toggle button) and by any module
   * that must repaint a CANVAS when the palette changes — CSS variables
   * restyle the DOM for free, but a canvas has to be redrawn, so listeners
   * subscribe to the `themechange` event on window. */
  window.Theme = {
    resolved: resolved,
    stored: stored,
    get: function () { return window.Theme.resolved; },
    /* Persist + apply an explicit theme (or "system" to follow the OS). */
    set: function (value) {
      if (THEME_VALUES.indexOf(value) < 0) value = "dark";
      try { localStorage.setItem(THEME_KEY, value); } catch (e) {}
      window.Theme.stored = value;
      window.Theme.resolved = apply(themeFromStored(value, systemPrefersLight()));
      window.dispatchEvent(new CustomEvent("themechange", {
        detail: { theme: window.Theme.resolved },
      }));
      return window.Theme.resolved;
    },
    toggle: function () { return window.Theme.set(nextTheme(window.Theme.resolved)); },
  };
})();
