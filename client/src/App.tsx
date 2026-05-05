import { HashRouter, Routes, Route } from "react-router-dom";
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

function AppRouter() {
  return (
    <HashRouter>
      <div className="flex flex-col h-screen overflow-hidden">
        {/* Custom title bar — always visible on all views */}
        <TitleBar />
        {/* Cross-window Fix-in-progress chip — single source of
            truth for the chip across every route in the main
            window (Home, Source Selection, Workspace). Interactive
            variant: clicking the Open button dispatches a window
            event that un-minimises the FixProgressModal. */}
        <FixStatusChip interactive />
        {/* Page content fills remaining space */}
        <div className="flex-1 overflow-hidden">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/source-selection" element={<SourceSelection />} />
            <Route path="/workspace" element={<Workspace />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </div>
        {/* Window resize-corner hints — CSS handles bottom two via body
            ::before/::after; these two provide the top-left / top-right
            brackets. All four are pointer-events: none, see index.css. */}
        <div className="window-resize-hint-tl" aria-hidden="true" />
        <div className="window-resize-hint-tr" aria-hidden="true" />
      </div>
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
