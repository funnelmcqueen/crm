import { SearchX } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";

// Identical for a lead that does not exist and one the viewer cannot access (SPEC 1).
export default function LeadNotFound() {
  return (
    <EmptyState
      icon={<SearchX />}
      title="Lead not found"
      description="Check the link, or find the lead from your list."
      action={
        <Button asChild className="h-12 px-5 font-bold">
          <Link href="/leads">Back to leads</Link>
        </Button>
      }
      className="mt-8"
    />
  );
}
