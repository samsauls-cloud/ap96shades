import { Link, useLocation } from "react-router-dom";
import { FileText, ScanLine, GitCompare } from "lucide-react";

export function InvoiceNav() {
  const { pathname } = useLocation();

  const links = [
    { to: "/invoices", label: "Invoice Database", icon: FileText },
    { to: "/invoices/reader", label: "PDF Reader", icon: ScanLine },
    { to: "/invoices/match", label: "Match Report", icon: GitCompare },
  ];

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
          <nav className="flex gap-1 ml-4">
            {links.map(l => (
              <Link
                key={l.to}
                to={l.to}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  pathname === l.to
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent"
                }`}
              >
                <l.icon className="h-3.5 w-3.5" />
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
      </div>
    </header>
  );
}
