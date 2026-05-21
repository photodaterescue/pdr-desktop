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

// Boot-splash dismissal — adaptive timing.
//
// MIN (3 s): enough time for the staggered entrance animation
//   (logo + name + tagline + bar) to complete + minimum brand
//   exposure. Even on a fast machine where React paints in <1 s
//   the splash holds for the full minimum so it never feels
//   rushed.
//
// MAX (6.5 s): cap for slower machines. If React's heavy work
//   (Welcome mount, AppShell layout, sidebar measurement) is
//   still in flight when this hits, dismiss anyway — the user
//   should never wait longer than this.
//
// READY signal: React calls window.__pdrSplashReady() once
//   Welcome (home.tsx) has mounted and rendered its first frame.
//   The splash exits as soon as the MIN floor is satisfied AND
//   the ready signal has fired — adaptive, so fast machines get
//   the minimum 3 s and slower machines get the time they need
//   up to the MAX ceiling.
const SPLASH_MIN_DISPLAY_MS = 3000;
const SPLASH_MAX_DISPLAY_MS = 6500;
const SPLASH_EXIT_DURATION_MS = 700;
const splashStartedAt = performance.now();
let splashReady = false;
let splashDismissed = false;
let splashRetryTimer: number | null = null;

function performSplashExit() {
  if (splashDismissed) return;
  splashDismissed = true;
  if (splashRetryTimer !== null) {
    window.clearTimeout(splashRetryTimer);
    splashRetryTimer = null;
  }
  const splash = document.getElementById("pdr-splash");
  if (!splash) return;
  splash.classList.add("pdr-splash-exit");
  window.setTimeout(() => splash.remove(), SPLASH_EXIT_DURATION_MS + 80);
}

function tryDismissBootSplash() {
  if (splashDismissed) return;
  const elapsed = performance.now() - splashStartedAt;

  // Below the floor — schedule a recheck at the floor.
  if (elapsed < SPLASH_MIN_DISPLAY_MS) {
    splashRetryTimer = window.setTimeout(
      tryDismissBootSplash,
      SPLASH_MIN_DISPLAY_MS - elapsed,
    );
    return;
  }

  // Past the floor, ready signal received — exit now.
  if (splashReady) {
    performSplashExit();
    return;
  }

  // Past the floor, no ready signal yet, ceiling not hit — wait
  // and retry in small steps so we exit promptly when ready fires.
  if (elapsed < SPLASH_MAX_DISPLAY_MS) {
    splashRetryTimer = window.setTimeout(tryDismissBootSplash, 100);
    return;
  }

  // Ceiling hit — exit regardless.
  performSplashExit();
}

// Expose the ready signal globally. React (home.tsx) calls this once
// Welcome has mounted and committed its first paint. If the splash
// hasn't dismissed yet the call triggers an immediate re-evaluation.
(window as Window & { __pdrSplashReady?: () => void }).__pdrSplashReady = () => {
  splashReady = true;
  tryDismissBootSplash();
};

requestAnimationFrame(() => {
  // Two RAFs — the first lets React commit, the second runs after the
  // browser paints. Kicks off the dismissal state machine which then
  // honours the min/max/ready constraints.
  requestAnimationFrame(tryDismissBootSplash);
});

// Hard safety net: even if the state machine somehow stalls (e.g.
// React never mounts), force-exit at the ceiling.
window.setTimeout(performSplashExit, SPLASH_MAX_DISPLAY_MS + 500);