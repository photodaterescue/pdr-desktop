import { createRoot } from "react-dom/client";
import { Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <Router hook={useHashLocation}>
    <App />
  </Router>
);

// Boot-splash dismissal. The splash (see index.html) covers the
// unavoidable Electron + Vite bundle load and the early renderer work
// (DB cleanup, sidebar measurement, etc.). It's intentionally held on
// screen for a minimum of 3 seconds so the staggered entrance
// animation has time to complete and the user gets a proper branded
// boot moment rather than a flash. After the minimum hold the splash
// runs a 700 ms scale-up + fade exit so it transitions gracefully into
// the Welcome screen behind it.
const SPLASH_MIN_DISPLAY_MS = 3000;
const SPLASH_EXIT_DURATION_MS = 700;
const splashStartedAt = performance.now();
let splashDismissed = false;

function dismissBootSplash() {
  if (splashDismissed) return;
  splashDismissed = true;
  const splash = document.getElementById("pdr-splash");
  if (!splash) return;
  const elapsed = performance.now() - splashStartedAt;
  const wait = Math.max(0, SPLASH_MIN_DISPLAY_MS - elapsed);
  window.setTimeout(() => {
    splash.classList.add("pdr-splash-exit");
    // Match the CSS transition (700ms) plus a small buffer before
    // removing from the DOM.
    window.setTimeout(() => splash.remove(), SPLASH_EXIT_DURATION_MS + 80);
  }, wait);
}
requestAnimationFrame(() => {
  // Two RAFs — the first lets React commit, the second runs after the
  // browser paints. Welcome is painted behind the splash by this point;
  // the minimum-hold timer in dismissBootSplash decides when it
  // actually reveals.
  requestAnimationFrame(dismissBootSplash);
});
// Safety timer: caps total splash visibility even if first paint
// somehow never happens.
window.setTimeout(dismissBootSplash, 8000);