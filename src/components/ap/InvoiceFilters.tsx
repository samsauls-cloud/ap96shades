import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Search, X } from "lucide-react";
import type { InvoiceFilters as Filters } from "@/lib/supabase-queries";

interface Props {
  filters: Filters;
  onChange: (filters: Filters) => void;
}

export function InvoiceFiltersBar({ filters, onChange }: Props) {
  const update = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex-1 min-w-[180px]">
        <label className="text-xs font-medium text-muted-foreground mb-1 block">Vendor</label>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search vendor…"
            value={filters.vendor || ""}
            onChange={(e) => update({ vendor: e.target.value })}
            className="pl-9"
          />
        </div>
      </div>

      <div className="min-w-[140px]">
        <label className="text-xs font-medium text-muted-foreground mb-1 block">Status</label>
        <Select
          value={filters.status || "all"}
          onValueChange={(v) => update({ status: v as Filters["status"] })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="unpaid">Unpaid</SelectItem>
            <SelectItem value="paid">Paid</SelectItem>
            <SelectItem value="disputed">Disputed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="min-w-[150px]">
        <label className="text-xs font-medium text-muted-foreground mb-1 block">From Date</label>
        <Input
          type="date"
          value={filters.dateFrom || ""}
          onChange={(e) => update({ dateFrom: e.target.value })}
        />
      </div>

      <div className="min-w-[150px]">
        <label className="text-xs font-medium text-muted-foreground mb-1 block">To Date</label>
        <Input
          type="date"
          value={filters.dateTo || ""}
          onChange={(e) => update({ dateTo: e.target.value })}
        />
      </div>

      <Button
        variant="ghost"
        size="sm"
        onClick={() => onChange({ status: "all" })}
        className="text-muted-foreground"
      >
        <X className="h-4 w-4 mr-1" /> Clear
      </Button>
    </div>
  );
}
