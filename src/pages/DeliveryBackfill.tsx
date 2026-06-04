import { InvoiceNav } from "@/components/invoices/InvoiceNav";
import { EomDeliveryBackfillSection } from "@/components/invoices/EomDeliveryBackfillSection";

export default function DeliveryBackfillPage() {
  return (
    <div className="min-h-screen bg-background">
      <InvoiceNav />
      <main className="max-w-[1400px] mx-auto px-4 sm:px-6 py-6 space-y-4">
        <div>
          <h1 className="text-xl font-bold">EOM Delivery-Date Backfill</h1>
          <p className="text-sm text-muted-foreground">
            Two-phase recovery for EOM-based invoices with missing delivery dates.
          </p>
        </div>
        <EomDeliveryBackfillSection />
      </main>
    </div>
  );
}
