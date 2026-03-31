import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { FileText, ScanLine, GitCompare, BarChart3, FileBarChart, PackageCheck, Shield, LogOut, Menu, X, Upload, ClipboardCheck, FileSearch } from "lucide-react";
import { Button } from "@/components/ui/button";


export function InvoiceNav() {
  const { pathname } = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  const links = [
    { to: "/invoices", label: "Invoice Database", icon: FileText },
    { to: "/invoices/reader", label: "PDF Reader", icon: ScanLine },
    { to: "/import/lightspeed", label: "Lightspeed Import", icon: Upload },
    { to: "/invoices/match", label: "Match Report", icon: GitCompare },
    { to: "/invoices/dashboard", label: "AP Dashboard", icon: BarChart3 },
    { to: "/invoices/reports", label: "Reports", icon: FileBarChart },
    { to: "/invoices/receiving", label: "Receiving", icon: PackageCheck },
    { to: "/reconciliation", label: "Reconciliation", icon: Shield },
    { to: "/audit", label: "Audit", icon: ClipboardCheck },
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
                  className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    pathname === l.to
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent"
                  }`}
                >
                  <l.icon className="h-3.5 w-3.5" />
                  {l.label}
                  {'badge' in l && (l as any).badge > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 flex items-center gap-0.5 rounded-full bg-destructive text-destructive-foreground text-[7px] font-bold px-1.5 py-0.5 whitespace-nowrap">
                      {(l as any).badgeContent || (l as any).badge}
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
        {/* Mobile nav dropdown */}
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
                {'badge' in l && (l as any).badge > 0 && (
                  <span className="ml-auto text-[9px] font-bold">{(l as any).badgeContent}</span>
                )}
              </Link>
            ))}
          </nav>
        )}
    </header>
  );
}
