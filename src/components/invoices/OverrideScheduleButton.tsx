import { SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  onClick: () => void;
  active?: boolean; // override panel currently open
  mismatch?: boolean; // counts don't match — pulse for attention
  disabled?: boolean;
  size?: "sm" | "default";
  className?: string;
}

/**
 * One unified "Override Schedule" button used across the Pre-Save Review card,
 * the InvoiceDrawer, and the TermsConfirmationPanel. Amber accent, sliders icon,
 * pulses on mismatch (respects prefers-reduced-motion).
 */
export function OverrideScheduleButton({
  onClick,
  active = false,
  mismatch = false,
  disabled = false,
  size = "default",
  className,
}: Props) {
  return (
    <Button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label="Override payment schedule"
      title="Manually set installments, dates, and amounts — replaces the auto-generated schedule"
      className={cn(
        "gap-2 font-semibold text-white shadow-sm rounded-md",
        "bg-amber-500 hover:bg-amber-600 focus-visible:ring-amber-400",
        size === "default" && "h-11 px-5 text-sm",
        size === "sm" && "h-9 px-3 text-xs",
        mismatch && !active && [
          "ring-2 ring-amber-400 ring-offset-2 ring-offset-background",
          "motion-safe:animate-pulse",
        ],
        className,
      )}
    >
      {active ? <X className="h-4 w-4" /> : <SlidersHorizontal className="h-4 w-4" />}
      {active ? "Cancel override" : "Override Schedule"}
    </Button>
  );
}

interface HelperProps {
  mismatch?: { expected: number; actual: number } | null;
}

/** Standard helper line that lives right below an OverrideScheduleButton. */
export function OverrideScheduleHelper({ mismatch }: HelperProps) {
  if (mismatch) {
    return (
      <p className="text-xs text-amber-600 font-medium mt-1.5">
        ⚠ Preview shows {mismatch.expected} installment
        {mismatch.expected === 1 ? "" : "s"} but {mismatch.actual}{" "}
        {mismatch.actual === 1 ? "is" : "are"} saved — click Override Schedule to adjust.
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground mt-1.5">
      Need custom dates, amounts, or a different number of installments? Click Override Schedule.
    </p>
  );
}
