import { Skeleton } from "@/components/ui/skeleton";

export default function NextLeadLoading() {
  return (
    <div aria-busy="true" aria-label="Finding your next lead" className="flex flex-col gap-4">
      <Skeleton className="h-9 w-48" />
      <div className="flex flex-col gap-3 rounded-xl border bg-card p-5">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="mt-2 h-14 w-full md:w-48" />
      </div>
    </div>
  );
}
