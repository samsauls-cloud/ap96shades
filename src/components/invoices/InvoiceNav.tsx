import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { FileText, ScanLine, BarChart3, LogOut, Menu, X, FileSearch, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useQuery } from "@tanstack/react-query";
import { fetchAllVendorCreditBalances } from "@/lib/vendor-credits";

function formatShort(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return `$${n.toFixed(0)}`;
}

export function InvoiceNav() {
  const { pathname } = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  const { data: balances = [] } = useQuery({
    queryKey: ["vendor_credit_balances"],
    queryFn: fetchAllVendorCreditBalances,
    staleTime: 30_000,
  });
  const totalCredit = balances.filter(b => b.balance > 0).reduce((s, b) => s + b.balance, 0);

  const links: Array<{
    to: string;
    label: string;
    icon: any;
    primary?: boolean;
    badge?: number;
    badgeContent?: string;
    badgeTone?: string;
  }> = [
    { to: "/invoices", label: "Invoices", icon: FileText },
    { to: "/invoices/reader", label: "Upload", icon: ScanLine },
    { to: "/invoices/ledger-check", label: "Ledger Check", icon: FileSearch },
    {
      to: "/invoices/credits",
      label: "Credits",
      icon: Wallet,
      badge: totalCredit > 0 ? 1 : 0,
      badgeContent: totalCredit > 0 ? formatShort(totalCredit) : "",
      badgeTone: "bg-emerald-500 text-white",
    },
    { to: "/invoices/dashboard", label: "Dashboard", icon: BarChart3, primary: true },
  ];

  const handleLogout = () => {
    sessionStorage.removeItem("invoice_companion_auth");
    window.location.reload();
  };

  return (
    <header className="border-b border-border bg-card/80 backdrop-blur-sm sticky top-0 z-20">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/invoices" className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-md bg-primary flex items-center justify-center">
                <FileText className="h-4 w-4 text-primary-foreground" />
              </div>
              <div>
                <h1 className="text-sm font-bold tracking-tight leading-none">NinetySix Shades</h1>
                <p className="text-[10px] text-muted-foreground">AP Invoice System</p>
              </div>
            </Link>
            <nav className="hidden md:flex gap-1 ml-4">
              {links.map(l => (
                <Link
                  key={l.to}
                  to={l.to}
                  className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs transition-colors ${
                    pathname === l.to
                      ? "bg-primary text-primary-foreground font-semibold"
                      : l.primary
                        ? "text-foreground font-bold hover:bg-accent"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent font-medium"
                  }`}
                >
                  <l.icon className="h-3.5 w-3.5" />
                  {l.label}
                  {l.badge && l.badge > 0 && (
                    <span className={`ml-1 rounded px-1 py-0.5 text-[9px] font-bold whitespace-nowrap ${l.badgeTone ?? "bg-destructive text-destructive-foreground"}`}>
                      {l.badgeContent || l.badge}
                    </span>
                  )}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleLogout}
              className="text-muted-foreground hover:text-foreground gap-1.5 text-xs"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Lock</span>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden h-8 w-8"
              onClick={() => setMobileOpen(v => !v)}
            >
              {mobileOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
            </Button>
          </div>
        </div>
        {mobileOpen && (
          <nav className="md:hidden border-t border-border bg-card px-4 py-2 flex flex-col gap-1">
            {links.map(l => (
              <Link
                key={l.to}
                to={l.to}
                onClick={() => setMobileOpen(false)}
                className={`flex items-center gap-2 px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
                  pathname === l.to
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent"
                }`}
              >
                <l.icon className="h-4 w-4" />
                {l.label}
                {l.badge && l.badge > 0 && (
                  <span className={`ml-auto rounded px-1 py-0.5 text-[9px] font-bold ${l.badgeTone ?? ""}`}>
                    {l.badgeContent}
                  </span>
                )}
              </Link>
            ))}
          </nav>
        )}
    </header>
  );
}
