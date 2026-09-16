import { Skeleton } from "@/components/ui/skeleton";

export default function AgentActivityLoading() {
  return (
    <div role="status" aria-label="Loading agent activity">
      <Skeleton className="mb-3 h-5 w-20" />
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-5 w-72" />
        </div>
        <Skeleton className="h-12 w-32" />
      </div>
      <Skeleton className="mb-4 h-12 w-72" />
      <div className="mb-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border sm:grid-cols-4 lg:grid-cols-7">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="flex flex-col gap-2 bg-card p-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-7 w-12" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[20rem_1fr]">
        <Skeleton className="h-72 w-full rounded-xl" />
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
