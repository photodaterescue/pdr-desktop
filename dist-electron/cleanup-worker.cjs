"use strict";
/**
 * PDR cleanup worker — runs in an Electron utilityProcess so the
 * recursive deletion of a 50 GB extracted Takeout doesn't block the
 * main browser thread. Without this, fs.rmSync(tempDir, { recursive,
 * force }) holds the main thread for 10–20 seconds while NTFS unlinks
 * thousands of files, ghosting the window as "Not Responding".
 *
 * Why this exists (Terry 2026-05-25):
 *   The post-fix cleanup flow ran inside the analysis:cleanupTempDir-
 *   ForSource IPC, calling cleanupTempDir which used fs.rmSync. That
 *   was the residual freeze after Fix-complete + Add Source: the main
 *   process was deleting 50 GB while the renderer was already trying
 *   to open the folder browser. Off-process keeps the main browser
 *   thread completely free.
 *
 * Lifecycle:
 *   1. Main forks ONE worker at app startup via preforkCleanupWorker.
 *   2. The worker stays alive across many delete requests (different
 *      from extract-worker which is one-shot per extraction).
 *   3. Main posts { type: 'delete', id, path } to request a delete.
 *      Worker replies with { type: 'done', id, ok, reason? }.
 *   4. id ties replies to their request so multiple in-flight deletes
 *      don't get tangled (rare in practice but safe by design).
 *   5. If the worker exits unexpectedly, main spawns a fresh one.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const parentPort = process.parentPort;
parentPort.on('message', async (e) => {
    const msg = e.data;
    if (!msg || msg.type !== 'delete' || typeof msg.path !== 'string' || typeof msg.id !== 'number') {
        return;
    }
    try {
        // fs.promises.rm with { recursive: true, force: true } walks the
        // tree asynchronously. Each file unlink + dir rmdir is its own
        // async op, yielding to the event loop between operations. On a
        // 50 GB Takeout this still takes 10–20s wall-clock — but it's all
        // in the worker process, so the main browser thread is unaffected.
        if (fs.existsSync(msg.path)) {
            await fs.promises.rm(msg.path, { recursive: true, force: true });
        }
        parentPort.postMessage({ type: 'done', id: msg.id, ok: true });
    }
    catch (err) {
        parentPort.postMessage({
            type: 'done',
            id: msg.id,
            ok: false,
            reason: err.message,
        });
    }
});
