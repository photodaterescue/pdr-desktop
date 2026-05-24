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

// v2.0.11 (Terry 2026-05-24) — workspace-ready signal to the main
// process. Two requestAnimationFrames after render() returns:
//
//   First RAF: runs after React has committed its first frame
//     (createRoot.render schedules the commit asynchronously).
//   Second RAF: runs after the browser has painted that commit
//     into Chromium's offscreen buffer.
//
// By the time the second RAF's callback fires, the actual workspace
// UI is painted in the renderer process — main can safely show the
// BrowserWindow and the user sees the dashboard immediately instead
// of a lavender body-background flash. Without this signal, main
// fell back to BrowserWindow's 'ready-to-show' event which fires on
// the FIRST paint (the empty document with lavender body, before
// React mounts) — Terry's "old splash trying to load for a split
// second before the WS loaded up" symptom.
//
// Fire-and-forget — main's ipcMain.on('workspace:first-frame') just
// flips a coordinator flag and runs maybeFinishStartup.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    try { (window as Window & { pdr?: { workspaceFirstFrame?: () => void } }).pdr?.workspaceFirstFrame?.(); } catch {
      // Best-effort — splash hard-timeout (SPLASH_HARD_MAX_MS in
      // main.ts) is the safety net if the signal never arrives.
    }
  });
});
