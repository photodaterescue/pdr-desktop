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
// unavoidable 2-3 second Electron + Vite bundle load. We wait one
// animation frame after createRoot.render so React has at least
// scheduled its first paint, then fade the splash out and remove it.
// A 4-second safety timer guarantees the splash never strands the
// user even if the first paint is somehow delayed.
function dismissBootSplash() {
  const splash = document.getElementById("pdr-splash");
  if (!splash) return;
  splash.classList.add("pdr-splash-hide");
  // Match the CSS transition (350ms) plus a small buffer before
  // removing from the DOM.
  window.setTimeout(() => splash.remove(), 450);
}
requestAnimationFrame(() => {
  // Two RAFs — the first lets React commit, the second runs after the
  // browser paints. Empirically this is the moment the user actually
  // sees Welcome on screen, so the splash fades out into the painted
  // app rather than into a half-rendered placeholder.
  requestAnimationFrame(dismissBootSplash);
});
window.setTimeout(dismissBootSplash, 4000);