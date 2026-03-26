import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PasswordGate } from "@/components/PasswordGate";
import Index from "./pages/Index.tsx";
import InvoicesPage from "./pages/Invoices.tsx";
import ReaderPage from "./pages/Reader.tsx";
import MatchReportPage from "./pages/MatchReport.tsx";
import APDashboardPage from "./pages/APDashboard.tsx";
import ReportsPage from "./pages/Reports.tsx";
import NotFound from "./pages/NotFound.tsx";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <PasswordGate>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Index />} />
            <Route path="/invoices" element={<InvoicesPage />} />
            <Route path="/invoices/reader" element={<ReaderPage />} />
            <Route path="/invoices/match" element={<MatchReportPage />} />
            <Route path="/invoices/dashboard" element={<APDashboardPage />} />
            <Route path="/invoices/reports" element={<ReportsPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </PasswordGate>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
