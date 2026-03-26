import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { MoreHorizontal, CheckCircle2, AlertTriangle, RotateCcw } from "lucide-react";
import { StatusBadge } from "./StatusBadge";
import type { VendorInvoice, InvoiceStatus } from "@/lib/supabase-queries";
import { format } from "date-fns";

interface Props {
  invoices: VendorInvoice[];
  onStatusChange: (id: string, status: InvoiceStatus) => void;
}

function formatCurrency(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

function formatDate(d: string | null) {
  if (!d) return "—";
  return format(new Date(d), "MMM d, yyyy");
}

export function InvoiceTable({ invoices, onStatusChange }: Props) {
  if (invoices.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <p className="text-lg font-medium">No invoices found</p>
        <p className="text-sm">Try adjusting your filters or add some invoices.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card overflow-auto">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/50">
            <TableHead className="font-semibold">Vendor</TableHead>
            <TableHead className="font-semibold">Invoice #</TableHead>
            <TableHead className="font-semibold">PO #</TableHead>
            <TableHead className="font-semibold">Date</TableHead>
            <TableHead className="font-semibold">Due Date</TableHead>
            <TableHead className="font-semibold text-right">Total</TableHead>
            <TableHead className="font-semibold">Status</TableHead>
            <TableHead className="font-semibold">Terms</TableHead>
            <TableHead className="w-[50px]"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invoices.map((inv) => (
            <TableRow key={inv.id} className="hover:bg-muted/30">
              <TableCell className="font-medium">{inv.vendor}</TableCell>
              <TableCell className="font-mono text-sm">{inv.invoice_number}</TableCell>
              <TableCell className="text-sm text-muted-foreground">{inv.po_number || "—"}</TableCell>
              <TableCell className="text-sm">{formatDate(inv.invoice_date)}</TableCell>
              <TableCell className="text-sm">{formatDate(inv.due_date)}</TableCell>
              <TableCell className="text-right font-semibold tabular-nums">
                {formatCurrency(inv.total)}
              </TableCell>
              <TableCell>
                <StatusBadge status={inv.status} />
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">{inv.payment_terms || "—"}</TableCell>
              <TableCell>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {inv.status !== "paid" && (
                      <DropdownMenuItem onClick={() => onStatusChange(inv.id, "paid")}>
                        <CheckCircle2 className="h-4 w-4 mr-2 text-emerald-600" />
                        Mark as Paid
                      </DropdownMenuItem>
                    )}
                    {inv.status !== "disputed" && (
                      <DropdownMenuItem onClick={() => onStatusChange(inv.id, "disputed")}>
                        <AlertTriangle className="h-4 w-4 mr-2 text-rose-600" />
                        Flag as Disputed
                      </DropdownMenuItem>
                    )}
                    {inv.status !== "unpaid" && (
                      <DropdownMenuItem onClick={() => onStatusChange(inv.id, "unpaid")}>
                        <RotateCcw className="h-4 w-4 mr-2 text-amber-600" />
                        Reset to Unpaid
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
