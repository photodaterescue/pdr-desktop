import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LicenseProvider } from "@/contexts/LicenseContext";
import NotFound from "@/pages/not-found";
import Home from "@/pages/home";
import Workspace from "@/pages/workspace";
import SourceSelection from "@/pages/source-selection";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/source-selection" component={SourceSelection} />
      <Route path="/workspace" component={Workspace} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <LicenseProvider>
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </LicenseProvider>
    </QueryClientProvider>
  );
}

export default App;
