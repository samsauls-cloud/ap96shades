import { useState, useEffect } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { formatCurrency, getLineItems, type VendorInvoice, type LineItem } from "@/lib/supabase-queries";


type SKUStatus = "have_it" | "on_floor" | "received_not_shelved" | "billed_not_received" | "not_in_system" | "discontinued";

interface SKUCheckRow {
  upc: string;
  itemNumber: string;
  description: string;
  billedQty: number;
  billedCost: number;
  onHand: string;
  onFloor: string;
  received: string;
  status: SKUStatus;
  costVariance: number | null;
  costVariancePercent: number | null;
}

const STATUS_CONFIG: Record<SKUStatus, { label: string; icon: string; className: string }> = {
  have_it: { label: "HAVE IT", icon: "✅", className: "bg-green-500/10 text-green-500 border-green-500/20" },
  on_floor: { label: "ON FLOOR", icon: "🏪", className: "bg-blue-500/10 text-blue-500 border-blue-500/20" },
  received_not_shelved: { label: "RECEIVED NOT SHELVED", icon: "📦", className: "bg-amber-500/10 text-amber-500 border-amber-500/20" },
  billed_not_received: { label: "BILLED NOT RECEIVED", icon: "🔄", className: "bg-orange-500/10 text-orange-500 border-orange-500/20" },
  not_in_system: { label: "NOT IN SYSTEM", icon: "❌", className: "bg-destructive/10 text-destructive border-destructive/20" },
  discontinued: { label: "DISCONTINUED", icon: "⚠️", className: "bg-muted text-muted-foreground border-border" },
};

interface Props {
  invoice: VendorInvoice;
}

export function SKUCheckTab({ invoice }: Props) {
  const [rows, setRows] = useState<SKUCheckRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    runSKUCheck();
  }, [invoice.id]);

  async function runSKUCheck() {
    setLoading(true);
    const lineItems = getLineItems(invoice);
    if (lineItems.length === 0) {
      setRows([]);
      setLoading(false);
      return;
    }

    // Collect all UPCs and SKUs
    const upcs = lineItems.map(li => li.upc).filter(Boolean) as string[];
    const skus = lineItems.map(li => li.item_number || li.sku).filter(Boolean) as string[];
    const allCodes = [...new Set([...upcs, ...skus])];

    if (allCodes.length === 0) {
      setRows(lineItems.map(li => buildEmptyRow(li)));
      setLoading(false);
      return;
    }

    // Fetch all four sources in parallel
    const [itemMasterData, planogramData, receivingData, inventoryData] = await Promise.all([
      fetchItemMaster(allCodes),
      fetchPlanogram(allCodes),
      fetchReceiving(allCodes),
      fetchInventory(allCodes),
    ]);

    // Build lookup maps
    const itemMasterMap = new Map<string, any>();
    itemMasterData.forEach(r => {
      if (r.upc) itemMasterMap.set(r.upc, r);
      if (r.model_number) itemMasterMap.set(r.model_number, r);
    });

    const planogramMap = new Map<string, any>();
    planogramData.forEach(r => {
      if (r.upc) planogramMap.set(r.upc, r);
      if (r.model_number) planogramMap.set(r.model_number, r);
    });

    const receivingMap = new Map<string, any>();
    receivingData.forEach(r => {
      if (r.upc) receivingMap.set(r.upc, r);
      if (r.manufact_sku) receivingMap.set(r.manufact_sku, r);
    });

    const inventoryMap = new Map<string, any>();
    inventoryData.forEach(r => {
      if (r.upc) inventoryMap.set(r.upc, r);
    });

    // Process each line item
    const result = lineItems.map(li => {
      const upc = li.upc || "";
      const sku = li.item_number || li.sku || "";
      const lookupKeys = [upc, sku].filter(Boolean);

      const itemMaster = lookupKeys.reduce<any>((found, key) => found || itemMasterMap.get(key), null);
      const planogram = lookupKeys.reduce<any>((found, key) => found || planogramMap.get(key), null);
      const receiving = lookupKeys.reduce<any>((found, key) => found || receivingMap.get(key), null);
      const inventory = lookupKeys.reduce<any>((found, key) => found || inventoryMap.get(key), null);

      // Determine status
      let status: SKUStatus = "not_in_system";
      const qtyOnHand = inventory?.quantity_on_hand ?? 0;

      if (planogram && (planogram.is_vendor_discontinued || planogram.is_discontinued)) {
        status = "discontinued";
      } else if (inventory && qtyOnHand > 0) {
        status = "have_it";
      } else if (planogram && planogram.go_out_location) {
        status = "on_floor";
      } else if (receiving && (receiving.received_qty || 0) > 0 && !planogram) {
        status = "received_not_shelved";
      } else if (itemMaster && !receiving) {
        status = "billed_not_received";
      } else if (receiving && (receiving.not_received_qty || 0) > 0) {
        status = "billed_not_received";
      } else if (!itemMaster && !planogram && !receiving && !inventory) {
        status = "not_in_system";
      }

      // Cost variance
      const invoicePrice = li.unit_price ?? 0;
      const refCost = receiving?.unit_cost ?? itemMaster?.wholesale_price ?? null;
      let costVariance: number | null = null;
      let costVariancePercent: number | null = null;
      if (refCost != null && invoicePrice > 0 && refCost > 0) {
        costVariance = invoicePrice - refCost;
        costVariancePercent = (costVariance / refCost) * 100;
      }

      return {
        upc: upc || sku || "—",
        itemNumber: sku || upc || "—",
        description: li.description || li.brand ? `${li.brand || ""} ${li.model || ""}`.trim() : "—",
        billedQty: li.qty_shipped ?? li.qty_ordered ?? li.qty ?? 0,
        billedCost: invoicePrice,
        onHand: inventory ? `${qtyOnHand}` : (itemMaster ? "✓" : "—"),
        onFloor: planogram?.go_out_location || "—",
        received: receiving ? `${receiving.received_qty ?? 0}` : "—",
        status,
        costVariance,
        costVariancePercent,
      };
    });

    setRows(result);
    setLoading(false);
  }

  function buildEmptyRow(li: LineItem): SKUCheckRow {
    return {
      upc: li.upc || "—",
      itemNumber: li.item_number || li.sku || "—",
      description: `${li.brand || ""} ${li.model || ""}`.trim() || "—",
      billedQty: li.qty_shipped ?? li.qty_ordered ?? li.qty ?? 0,
      billedCost: li.unit_price ?? 0,
      onHand: "—",
      onFloor: "—",
      received: "—",
      status: "not_in_system",
      costVariance: null,
      costVariancePercent: null,
    };
  }

  // Summary
  const confirmed = rows.filter(r => r.status === "have_it" || r.status === "on_floor").length;
  const backorder = rows.filter(r => r.status === "billed_not_received").length;
  const notInSystem = rows.filter(r => r.status === "not_in_system").length;
  const totalCostVariance = rows.reduce((sum, r) => {
    if (r.costVariance != null && Math.abs(r.costVariancePercent ?? 0) > 5) {
      return sum + Math.abs(r.costVariance) * r.billedQty;
    }
    return sum;
  }, 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-primary mr-2" />
        <span className="text-sm text-muted-foreground">Running SKU check…</span>
      </div>
    );
  }

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground py-4">No line items to check.</p>;
  }

  return (
    <div className="space-y-3">
      {/* Summary bar */}
      <div className="p-3 rounded-lg bg-secondary border border-border text-xs flex flex-wrap gap-3">
        <span><strong>{confirmed}</strong> of {rows.length} SKUs confirmed in inventory</span>
        <span className="text-muted-foreground">·</span>
        <span><strong>{backorder}</strong> on backorder</span>
        <span className="text-muted-foreground">·</span>
        <span><strong>{notInSystem}</strong> not in system</span>
        {totalCostVariance > 0 && (
          <>
            <span className="text-muted-foreground">·</span>
            <span className="text-destructive font-semibold">{formatCurrency(totalCostVariance)} total cost variance</span>
          </>
        )}
      </div>

      {/* Table */}
      <div className="rounded border border-border overflow-auto max-h-[400px]">
        <Table>
          <TableHeader>
            <TableRow className="border-border">
              <TableHead className="text-[10px] font-semibold">UPC/SKU</TableHead>
              <TableHead className="text-[10px] font-semibold">Description</TableHead>
              <TableHead className="text-[10px] font-semibold text-right">Billed Qty</TableHead>
              <TableHead className="text-[10px] font-semibold text-right">Billed Cost</TableHead>
              <TableHead className="text-[10px] font-semibold text-center">In System</TableHead>
              <TableHead className="text-[10px] font-semibold">On Floor</TableHead>
              <TableHead className="text-[10px] font-semibold text-right">Received</TableHead>
              <TableHead className="text-[10px] font-semibold">Status</TableHead>
              <TableHead className="text-[10px] font-semibold text-right">Cost Var.</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => {
              const isFlagged = r.costVariancePercent != null && Math.abs(r.costVariancePercent) > 5;
              return (
                <TableRow key={i} className="border-border">
                  <TableCell className="text-[10px] font-mono">{r.upc}</TableCell>
                  <TableCell className="text-[10px] max-w-[150px] truncate">{r.description}</TableCell>
                  <TableCell className="text-[10px] text-right tabular-nums">{r.billedQty}</TableCell>
                  <TableCell className="text-[10px] text-right tabular-nums">{formatCurrency(r.billedCost)}</TableCell>
                  <TableCell className="text-[10px] text-center">{r.onHand}</TableCell>
                  <TableCell className="text-[10px]">{r.onFloor}</TableCell>
                  <TableCell className="text-[10px] text-right tabular-nums">{r.received}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${STATUS_CONFIG[r.status].className}`}>
                      {STATUS_CONFIG[r.status].icon} {STATUS_CONFIG[r.status].label}
                    </Badge>
                  </TableCell>
                  <TableCell className={`text-[10px] text-right tabular-nums font-medium ${isFlagged ? "text-destructive" : ""}`}>
                    {r.costVariance != null ? (
                      <>
                        {r.costVariance > 0 ? "+" : ""}{formatCurrency(r.costVariance)}
                        {isFlagged && <span className="ml-1 text-[8px]">⚠</span>}
                      </>
                    ) : "—"}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

async function fetchItemMaster(codes: string[]) {
  if (codes.length === 0) return [];
  const { data } = await supabase
    .from("item_master")
    .select("upc, model_number, wholesale_price, retail_price, brand")
    .or(codes.map(c => `upc.eq.${c}`).join(","));
  return data ?? [];
}

async function fetchPlanogram(codes: string[]) {
  if (codes.length === 0) return [];
  const { data } = await supabase
    .from("current_planogram")
    .select("upc, model_number, go_out_location, backstock_location, is_vendor_discontinued, is_discontinued, frame_source")
    .or(codes.map(c => `upc.eq.${c}`).join(","));
  return data ?? [];
}

async function fetchReceiving(codes: string[]) {
  if (codes.length === 0) return [];
  const { data } = await supabase
    .from("lightspeed_receiving")
    .select("upc, manufact_sku, received_qty, not_received_qty, receiving_status, unit_cost")
    .or(codes.map(c => `upc.eq.${c}`).join(","));
  return data ?? [];
}

async function fetchInventory(codes: string[]) {
  if (codes.length === 0) return [];
  const { data } = await supabase
    .from("inventory_snapshots")
    .select("upc, quantity_on_hand, store_id, snapshot_date")
    .or(codes.map(c => `upc.eq.${c}`).join(","));
  return data ?? [];
}
