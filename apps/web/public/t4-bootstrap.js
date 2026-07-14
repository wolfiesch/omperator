// Critical theme boot: paint the correct background and accent on the
// very first frame, before any stylesheet or bundle arrives. The two
// background values mirror --background in packages/ui/src/tokens.css
// (#ffffff light; color-mix(oklch(0.145 0 0) 95%, #ffffff) = #161616
// dark) — keep them in sync with the token file.
// Android System WebView releases without Object.hasOwn still execute the
// vendored app-wire decoders. Install the standards-equivalent primitive
// before the module graph loads.
if (typeof Object.hasOwn !== "function") {
  Object.defineProperty(Object, "hasOwn", {
    configurable: true,
    writable: true,
    value: function hasOwn(object, property) {
      return Object.prototype.hasOwnProperty.call(object, property);
    },
  });
}

const doc = document.documentElement;
let dark = false;
try {
  const raw = localStorage.getItem("omp:workspace:v1");
  const theme = raw ? JSON.parse(raw).theme : "system";
  dark = theme === "dark" || (theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
} catch (_error) {
  void _error;
  dark = matchMedia("(prefers-color-scheme: dark)").matches;
}
if (dark) doc.classList.add("dark");
doc.style.backgroundColor = dark ? "#161616" : "#ffffff";
doc.style.colorScheme = dark ? "dark" : "light";
try {
  const accent = localStorage.getItem("t4-code:accent:v1");
  if (accent) doc.dataset.accent = accent;
} catch (_error) {
  void _error;
  // default accent
}

if (location.hash.startsWith("#/sessions/")) {
  doc.dataset.sessionReveal = "true";
}
// Capture the navigation snapshot before the app bundle mounts. The
// transcript layout effect skips it once LegendList has real content.
window.addEventListener("pagereveal", (event) => {
  const transition = event.viewTransition;
  if (transition && typeof transition.skipTransition === "function") {
    window.__t4ViewTransition = transition;
    transition.finished.then(() => {
      if (window.__t4ViewTransition === transition) delete window.__t4ViewTransition;
    }).catch(() => {
      if (window.__t4ViewTransition === transition) delete window.__t4ViewTransition;
    });
  }
});
