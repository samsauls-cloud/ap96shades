import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Search, X } from "lucide-react";
import type { InvoiceFilters } from "@/lib/supabase-queries";

interface Props {
  filters: InvoiceFilters;
  onChange: (f: InvoiceFilters) => void;
  vendors: string[];
  tags?: string[];
}

export function InvoiceFiltersBar({ filters, onChange, vendors, tags = [] }: Props) {
  const update = (patch: Partial<InvoiceFilters>) => onChange({ ...filters, ...patch, page: 1 });

  return (
    <div className="space-y-3">
      <div className="flex gap-2 sm:gap-3">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search invoices, POs, vendors…"
            value={filters.search || ""}
            onChange={e => update({ search: e.target.value })}
            className="pl-9 bg-secondary border-border"
          />
        </div>
        <Button variant="ghost" size="sm" onClick={() => onChange({ page: 1, perPage: 25 })} className="text-muted-foreground shrink-0">
          <X className="h-4 w-4 mr-1" /> <span className="hidden sm:inline">Clear</span>
        </Button>
      </div>

      <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2">
        <Select value={filters.vendor || "__all"} onValueChange={v => update({ vendor: v === "__all" ? undefined : v })}>
          <SelectTrigger className="w-full sm:w-[160px] bg-secondary border-border text-xs h-8">
            <SelectValue placeholder="Vendor" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">All Vendors</SelectItem>
            {vendors.map(v => <SelectItem key={v} value={v}>{v}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select value={filters.docType || "__all"} onValueChange={v => update({ docType: v === "__all" ? undefined : v })}>
          <SelectTrigger className="w-full sm:w-[120px] bg-secondary border-border text-xs h-8">
            <SelectValue placeholder="Doc Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">All Types</SelectItem>
            <SelectItem value="INVOICE">Invoice</SelectItem>
            <SelectItem value="PO">PO</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filters.source || "__all"} onValueChange={v => update({ source: v === "__all" ? undefined : v })}>
          <SelectTrigger className="w-full sm:w-[140px] bg-secondary border-border text-xs h-8">
            <SelectValue placeholder="Source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">All Sources</SelectItem>
            <SelectItem value="manual">PDF Upload</SelectItem>
            <SelectItem value="photo_capture">Photo Capture</SelectItem>
            <SelectItem value="csv_import">CSV Import</SelectItem>
          </SelectContent>
        </Select>
          <SelectTrigger className="w-full sm:w-[120px] bg-secondary border-border text-xs h-8">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">All Status</SelectItem>
            <SelectItem value="unpaid">Unpaid</SelectItem>
            <SelectItem value="paid">Paid</SelectItem>
            <SelectItem value="partial">Partial</SelectItem>
            <SelectItem value="disputed">Disputed</SelectItem>
          </SelectContent>
        </Select>

        {tags.length > 0 && (
          <Select value={filters.tag || "__all"} onValueChange={v => update({ tag: v === "__all" ? undefined : v })}>
            <SelectTrigger className="w-full sm:w-[140px] bg-secondary border-border text-xs h-8">
              <SelectValue placeholder="Tag" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">All Tags</SelectItem>
              {tags.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
            </SelectContent>
          </Select>
        )}

        <Input
          type="date"
          value={filters.dateFrom || ""}
          onChange={e => update({ dateFrom: e.target.value || undefined })}
          className="w-full sm:w-[140px] bg-secondary border-border text-xs h-8"
          placeholder="From"
        />
        <Input
          type="date"
          value={filters.dateTo || ""}
          onChange={e => update({ dateTo: e.target.value || undefined })}
          className="w-full sm:w-[140px] bg-secondary border-border text-xs h-8"
          placeholder="To"
        />
        <Input
          type="number"
          value={filters.minTotal ?? ""}
          onChange={e => update({ minTotal: e.target.value ? Number(e.target.value) : undefined })}
          className="w-full sm:w-[100px] bg-secondary border-border text-xs h-8"
          placeholder="Min $"
        />
        <Input
          type="number"
          value={filters.maxTotal ?? ""}
          onChange={e => update({ maxTotal: e.target.value ? Number(e.target.value) : undefined })}
          className="w-full sm:w-[100px] bg-secondary border-border text-xs h-8"
          placeholder="Max $"
        />
      </div>
    </div>
  );
}
