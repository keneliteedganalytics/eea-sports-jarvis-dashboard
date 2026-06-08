import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppLayout } from "@/components/AppLayout";
import Home from "@/pages/Home";
import PickDetail from "@/pages/PickDetail";
import Analytics from "@/pages/Analytics";
import TrackRecord from "@/pages/TrackRecord";
import SportStub from "@/pages/SportStub";
import NotFound from "@/pages/not-found";

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/pick/:id" component={PickDetail} />
      <Route path="/analytics" component={Analytics} />
      <Route path="/track-record" component={TrackRecord} />
      <Route path="/sports/:sport" component={SportStub} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router hook={useHashLocation}>
          <AppLayout>
            <AppRouter />
          </AppLayout>
        </Router>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
