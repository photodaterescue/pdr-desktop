import { createRoot } from "react-dom/client";
import { Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import App from "./App";
import "./index.css";

// v2.0.15 (Terry 2026-06-05) — boot timeline logs to diagnose the
// purple-flash gap. main.ts captures lines containing "[Boot]" and
// writes them into main.log with electron-log's own timestamp, so
// the renderer-side events interleave cleanly with the main-side
// events when reading the log.
console.log('[Boot] main.tsx loaded — bundle parsed, about to call createRoot.render');

createRoot(document.getElementById("root")!).render(
  <Router hook={useHashLocation}>
    <App />
  </Router>
);

console.log('[Boot] createRoot.render() returned (React commit scheduled, not yet painted)');

// v2.0.15 (Terry 2026-06-05) — workspace-first-frame signal MOVED
// from here (App-level RAF) to home.tsx (Welcome-level RAF). Reason:
// the previous double-RAF fired after App's first commit, but App's
// initial commit doesn't include Welcome's painted content — Welcome
// is a child route mounted via AppShell's Routes. In dev the bundle
// loaded fast so Welcome painted almost-immediately after App, and
// the gap was invisible. In packaged builds the bundle is bigger
// AND antivirus scans the freshly-installed .exe AND there's no
// Vite caching — Welcome could take 6 seconds to actually paint
// after App mounted. Main saw workspaceFirstFrame at App level, ran
// maybeFinishStartup, and showed the BrowserWindow against its
// lavender backgroundColor — Terry got a 6-second purple flash before
// the Welcome content finally rendered.
//
// Fix: home.tsx now fires BOTH __pdrSplashReady AND workspaceFirstFrame
// from its own double-RAF inside the Welcome useEffect — same RAF
// chain that's always been gating splash dismissal correctly. Main
// window now shows only after Welcome content is in the offscreen
// buffer.
