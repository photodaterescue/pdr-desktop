/* eslint-disable @typescript-eslint/no-var-requires */
// v2.1 round 312 (Terry) — tiny preload for the capture utility windows: the floating
// "Capture region" prep bar and the per-monitor region overlays. They were loading the FULL
// app preload (a large bundle that does a lot of setup), which took 5-10s before the prep bar
// even appeared. These windows only need a couple of IPC shims, so this exposes JUST those and
// they pop instantly. Same `window.pdr.*` surface the pages already use.
//
// IMPORTANT: a preload MUST be CommonJS when run by Electron (require, not ESM import) — see
// preload.ts. Wrapped in an IIFE so its top-level consts don't collide with preload.ts at the
// shared global scope (both are CJS scripts in the same tsconfig).
(function () {
  const { contextBridge, ipcRenderer } = require('electron');

  contextBridge.exposeInMainWorld('pdr', {
    capture: {
      onOverlayInit: (cb: (info: unknown) => void) => {
        const h = (_e: unknown, info: unknown) => cb(info);
        ipcRenderer.on('capture:overlay-init', h);
        return () => ipcRenderer.removeListener('capture:overlay-init', h);
      },
      overlaySelect: (rect: unknown) => ipcRenderer.send('capture:overlay-select', rect),
      overlayCancel: () => ipcRenderer.send('capture:overlay-cancel'),
    },
    captureBar: {
      capture: () => ipcRenderer.send('collage:prepCapture'),
      cancel: () => ipcRenderer.send('collage:prepCancel'),
    },
  });
})();
