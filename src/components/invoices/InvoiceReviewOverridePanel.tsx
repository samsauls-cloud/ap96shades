import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Plus, Trash2, RotateCcw } from "lucide-react";

export type OverrideInstallment = {
  due_date: string; // YYYY-MM-DD
  amount_due: number;
  installment_label: string;
};

export type OverridePayload = {
  finalPreset: string;
  installments: OverrideInstallment[];
  vendor: string;
  notes?: string;
};

interface Props {
  initialVendor: string;
  initialPreset: string;
  initialInstallments: OverrideInstallment[];
  invoiceTotal: number;
  anchorDate: string;
  onSave: (payload: OverridePayload) => void;
  onCancel: () => void;
}

export function InvoiceReviewOverridePanel({
  initialVendor,
  initialPreset,
  initialInstallments,
  invoiceTotal,
  anchorDate,
  onSave,
  onCancel,
}: Props) {
  const [vendor, setVendor] = useState(initialVendor);
  const [preset, setPreset] = useState(initialPreset);
  const [installments, setInstallments] = useState<OverrideInstallment[]>(
    initialInstallments.length > 0
      ? initialInstallments
      : [{ due_date: anchorDate, amount_due: invoiceTotal, installment_label: "Installment 1" }]
  );
  const [notes, setNotes] = useState("");

  const totalEntered = useMemo(
    () => installments.reduce((s, i) => s + (Number.isFinite(i.amount_due) ? i.amount_due : 0), 0),
    [installments],
  );
  const totalDelta = Math.round((totalEntered - invoiceTotal) * 100) / 100;
  const totalMismatch = Math.abs(totalDelta) > 0.01;

  function updateRow(idx: number, patch: Partial<OverrideInstallment>) {
    setInstallments((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setInstallments((prev) => [
      ...prev,
      { due_date: anchorDate, amount_due: 0, installment_label: `Installment ${prev.length + 1}` },
    ]);
  }
  function removeRow(idx: number) {
    setInstallments((prev) => prev.filter((_, i) => i !== idx));
  }
  function resetToAi() {
    setVendor(initialVendor);
    setPreset(initialPreset);
    setInstallments(initialInstallments);
    setNotes("");
  }

  const canSave =
    installments.length > 0 &&
    installments.every((r) => r.due_date && Number.isFinite(r.amount_due));

  return (
    <div className="border rounded-md p-3 space-y-3 bg-muted/40">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">Override AI suggestion</span>
        <Button variant="ghost" size="sm" onClick={resetToAi} type="button">
          <RotateCcw className="h-3 w-3 mr-1" />
          Reset to AI
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">Vendor</Label>
          <Input value={vendor} onChange={(e) => setVendor(e.target.value)} />
        </div>
        <div>
          <Label className="text-xs">Terms label / preset</Label>
          <Input
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
            placeholder="e.g. EOM 30/60/90, Net 30, custom"
          />
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label className="text-xs">Installments (your entries are authoritative)</Label>
          <Button variant="outline" size="sm" type="button" onClick={addRow}>
            <Plus className="h-3 w-3 mr-1" />
            Add
          </Button>
        </div>
        <div className="space-y-1">
          {installments.map((row, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-2 items-center">
              <Input
                className="col-span-4"
                placeholder="Label"
                value={row.installment_label}
                onChange={(e) => updateRow(idx, { installment_label: e.target.value })}
              />
              <Input
                className="col-span-4"
                type="date"
                value={row.due_date}
                onChange={(e) => updateRow(idx, { due_date: e.target.value })}
              />
              <Input
                className="col-span-3"
                type="number"
                step="0.01"
                value={row.amount_due}
                onChange={(e) => updateRow(idx, { amount_due: parseFloat(e.target.value || "0") })}
              />
              <Button
                className="col-span-1"
                variant="ghost"
                size="icon"
                type="button"
                onClick={() => removeRow(idx)}
                disabled={installments.length <= 1}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
        <div className={totalMismatch ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
          Sum: {totalEntered.toFixed(2)} / invoice total {invoiceTotal.toFixed(2)}
          {totalMismatch ? ` (off by ${totalDelta.toFixed(2)})` : " ✓"}
        </div>
      </div>

      <div>
        <Label className="text-xs">Notes (optional, written to audit log)</Label>
        <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. terms negotiated by phone" />
      </div>

      <div className="flex gap-2 justify-end">
        <Button variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={!canSave}
          onClick={() =>
            onSave({
              finalPreset: preset,
              installments,
              vendor: vendor.trim(),
              notes: notes.trim() || undefined,
            })
          }
        >
          Save override
        </Button>
      </div>
    </div>
  );
}
