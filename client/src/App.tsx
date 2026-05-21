import { HashRouter, Routes, Route, useLocation } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LicenseProvider } from "@/contexts/LicenseContext";
import { ToastListener } from "@/components/ToastListener";
import { UpdateNotification } from "@/components/UpdateNotification";
import { TitleBar } from "@/components/TitleBar";
import { FixStatusChip } from "@/components/FixStatusChip";

import NotFound from "@/pages/not-found";
import Home from "@/pages/home";
import Workspace from "@/pages/workspace";
import SourceSelection from "@/pages/source-selection";

const queryClient = new QueryClient();

// Workspace is mounted from app launch (after an idle delay so
// Welcome paints first) and toggled visible/hidden via display:none
// based on route. Every panel inside Workspace knows when it's
// hidden via a `paused` prop and refuses to do IPC-heavy work until
// the user clicks into it — SearchPanel especially, since its
// default-on filters would otherwise fire an 18,744-row search +
// per-tile ffmpeg spawns the moment workspace mounts. The shell
// (sidebar, titlebar, dashboard skeleton, Memories prefetch
// consumers) DOES run during the pre-mount, so the first sidebar
// click lands on an already-warmed tree. Terry 2026-05-20: "I want
// both… it will make the app seem so much faster".
function AppShell() {
  const location = useLocation();
  const isWorkspace = location.pathname === '/workspace';
  const [workspaceMounted, setWorkspaceMounted] = useState(false);
  // Snapshot of the last non-workspace location, so the Routes
  // block keeps rendering Welcome/SourceSelection while the
  // workspace fades IN over it. Without this, the moment the route
  // flips to /workspace the Routes would fall through to NotFound
  // and the fade-in would happen over an empty page. Updated only
  // when we're NOT on workspace, so during the entire fade-out the
  // last-seen Welcome content stays painted underneath.
  const lastNonWorkspaceLocationRef = useRef(location);
  useEffect(() => {
    if (!isWorkspace) {
      lastNonWorkspaceLocationRef.current = location;
    }
  }, [location, isWorkspace]);
  // Keep the Routes block mounted briefly after navigating INTO
  // /workspace so the fade-out has something to fade. Unmount it
  // 320ms later (slightly longer than the 300ms transition so the
  // last paint frame can complete). On navigating BACK out of
  // /workspace, the Routes block is re-mounted instantly so the
  // user sees Welcome content immediately as the workspace fades.
  const [routesMounted, setRoutesMounted] = useState(!isWorkspace);
  useEffect(() => {
    if (!isWorkspace) {
      setRoutesMounted(true);
      return;
    }
    const t = setTimeout(() => setRoutesMounted(false), 320);
    return () => clearTimeout(t);
  }, [isWorkspace]);
  useEffect(() => {
    if (workspaceMounted) return;
    if (isWorkspace) {
      setWorkspaceMounted(true);
      return;
    }
    const schedule = (cb: () => void) => {
      if (typeof (window as any).requestIdleCallback === 'function') {
        (window as any).requestIdleCallback(cb, { timeout: 1500 });
      } else {
        setTimeout(cb, 500);
      }
    };
    schedule(() => setWorkspaceMounted(true));
  }, [isWorkspace, workspaceMounted]);

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <TitleBar />
      <FixStatusChip interactive />
      <div className="flex-1 overflow-hidden relative">
        {workspaceMounted && (
          <div
            // Cross-fade workspace in/out instead of the old hard
            // display:none toggle. 300ms is the sweet spot — fast
            // enough not to feel sluggish, slow enough to register
            // as a deliberate transition. ease-out so the fade
            // settles gently. pointer-events:none prevents the
            // hidden workspace from intercepting clicks meant for
            // Welcome during the brief overlap. visibility:hidden
            // when fully faded keeps the workspace out of the
            // accessibility tree.
            className="absolute inset-0 transition-opacity duration-300 ease-out"
            style={{
              opacity: isWorkspace ? 1 : 0,
              pointerEvents: isWorkspace ? 'auto' : 'none',
              visibility: isWorkspace ? 'visible' : 'hidden',
            }}
            aria-hidden={!isWorkspace}
          >
            <Workspace />
          </div>
        )}
        {routesMounted && (
          <div
            className="absolute inset-0 transition-opacity duration-300 ease-out"
            style={{
              opacity: !isWorkspace ? 1 : 0,
              pointerEvents: !isWorkspace ? 'auto' : 'none',
            }}
            aria-hidden={isWorkspace}
          >
            <Routes location={isWorkspace ? lastNonWorkspaceLocationRef.current : location}>
              <Route path="/" element={<Home />} />
              <Route path="/source-selection" element={<SourceSelection />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </div>
        )}
      </div>
      <div className="window-resize-hint-tl" aria-hidden="true" />
      <div className="window-resize-hint-tr" aria-hidden="true" />
    </div>
  );
}

function AppRouter() {
  return (
    <HashRouter>
      <AppShell />
    </HashRouter>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <LicenseProvider>
        <TooltipProvider>
          <Toaster />
          {/* Sonner-flavoured toasts. The whole app's toast.error /
              toast.info calls go through sonner; without this mount
              the calls fire into the void with no visible UI. The
              shadcn Toaster above stays for any legacy useToast()
              callers. Position top-center because bottom-right got
              missed in the first review pass — it's the corner the
              eye reaches last. expand=true bumps each toast to
              full-width content (more legible than the default
              compressed pill). */}
          <SonnerToaster
            position="top-center"
            richColors
            closeButton
            expand
            toastOptions={{ duration: 5000, style: { fontSize: '14px' } }}
          />
          <ToastListener />
          <UpdateNotification />
          <AppRouter />
        </TooltipProvider>
      </LicenseProvider>
    </QueryClientProvider>
  );
}
