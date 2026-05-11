import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { TermsApprovalBadge } from "./Badges";
import { formatCurrency } from "@/lib/supabase-queries";

interface Props {
  invoiceId: string;
  termsConfidence?: string | null;
}

type AuditRow = {
  id: string;
  created_at: string;
  performed_by: string | null;
  metadata: any;
};

/**
 * Renders the "User Approved / User Overridden" badge plus the most recent
 * audit-log entry (notes, AI vs final preset, override installments).
 *
 * Self-hides when the invoice has no user-approval signal.
 */
export function TermsApprovalAudit({ invoiceId, termsConfidence }: Props) {
  const isUserAction =
    termsConfidence === "user_approved" || termsConfidence === "user_overridden";

  const { data: audit } = useQuery({
    queryKey: ["terms_approval_audit", invoiceId],
    enabled: !!invoiceId && isUserAction,
    queryFn: async (): Promise<AuditRow | null> => {
      const { data, error } = await supabase
        .from("recalc_audit_log")
        .select("id, created_at, performed_by, metadata")
        .eq("invoice_id", invoiceId)
        .eq("action", "user_terms_approval")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) return null;
      return data as AuditRow | null;
    },
  });

  if (!isUserAction) return null;

  const meta = audit?.metadata ?? {};
  const overridden = termsConfidence === "user_overridden";
  const aiPreset = meta.ai_extracted_preset ?? "—";
  const finalPreset = meta.final_preset ?? "—";
  const aiSource = meta.ai_extracted_source_text as string | undefined;
  const notes = meta.notes as string | undefined;
  const finalInstallments = (meta.final_installments ?? []) as Array<{
    due_date: string;
    amount_due: number;
    installment_label: string;
  }>;

  return (
    <div
      className={`mb-4 rounded-lg border p-3 ${
        overridden
          ? "bg-orange-500/5 border-orange-500/20"
          : "bg-emerald-500/5 border-emerald-500/20"
      }`}
    >
      <div className="flex items-center gap-2 mb-2">
        <TermsApprovalBadge termsConfidence={termsConfidence} />
        {audit?.created_at && (
          <span className="text-[10px] text-muted-foreground">
            {new Date(audit.created_at).toLocaleString()}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
        <div>
          <span className="text-muted-foreground">AI extracted: </span>
          <span className="font-mono">{aiPreset || "—"}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Final preset: </span>
          <span className="font-mono font-semibold">{finalPreset || "—"}</span>
        </div>
      </div>

      {aiSource && (
        <p className="mt-2 text-[10px] text-muted-foreground italic">
          Extractor saw: "{aiSource}"
        </p>
      )}

      {overridden && finalInstallments.length > 0 && (
        <div className="mt-2 space-y-0.5">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
            User-entered installments
          </p>
          {finalInstallments.map((r, i) => (
            <div key={i} className="flex justify-between text-[11px]">
              <span className="text-muted-foreground">
                {r.installment_label || `Installment ${i + 1}`}
              </span>
              <span className="font-mono">{r.due_date}</span>
              <span className="font-semibold tabular-nums">
                {formatCurrency(r.amount_due)}
              </span>
            </div>
          ))}
        </div>
      )}

      {notes && (
        <p className="mt-2 text-[11px]">
          <span className="text-muted-foreground font-medium">Notes: </span>
          <span>{notes}</span>
        </p>
      )}
    </div>
  );
}
