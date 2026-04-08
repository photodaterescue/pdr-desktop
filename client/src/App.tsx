import { HashRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LicenseProvider } from "@/contexts/LicenseContext";
import { ToastListener } from "@/components/ToastListener";
import { UpdateNotification } from "@/components/UpdateNotification";
import { TitleBar } from "@/components/TitleBar";

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
        {/* Page content fills remaining space */}
        <div className="flex-1 overflow-hidden">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/source-selection" element={<SourceSelection />} />
            <Route path="/workspace" element={<Workspace />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </div>
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
          <ToastListener />
          <UpdateNotification />
          <AppRouter />
        </TooltipProvider>
      </LicenseProvider>
    </QueryClientProvider>
  );
}
