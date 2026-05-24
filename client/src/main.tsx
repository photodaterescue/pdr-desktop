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

// v2.0.11 — the splash is now a separate BrowserWindow owned by the
// main process (see electron/main.ts's createSplashWindow() and
// maybeFinishStartup()). When the workspace renderer signals
// 'ready-to-show', the main process flips the workspaceReadyToShow
// flag in its coordinator; the splash gets closed and the workspace
// gets shown once the worker has also finished its cleanup. So this
// file no longer needs the splash-dismissal state machine — the
// workspace is simply hidden (show: false) until the coordinator
// reveals it.
