import { Skeleton } from "@/components/ui/skeleton";

export default function LeadsLoading() {
  return (
    <div role="status" aria-label="Loading leads">
      <div className="mb-6 flex flex-col gap-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-28" />
      </div>
      <Skeleton className="mb-2 h-12 w-full" />
      <div className="mb-4 flex flex-wrap gap-2">
        <Skeleton className="h-12 w-28" />
        <Skeleton className="h-12 w-36" />
        <Skeleton className="h-12 w-48" />
      </div>

      <div className="hidden overflow-hidden rounded-xl border bg-card md:block">
        <Skeleton className="h-11 w-full rounded-none" />
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex h-14 items-center gap-6 border-t px-4">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-6 w-20 rounded-full" />
            <Skeleton className="ml-auto h-4 w-8" />
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2 md:hidden">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex flex-col gap-3 rounded-xl border bg-card p-4">
            <div className="flex justify-between gap-3">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-6 w-20 rounded-full" />
            </div>
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-48" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
