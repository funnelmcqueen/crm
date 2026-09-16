import { Skeleton } from "@/components/ui/skeleton";

/** Role-neutral skeleton: a header, a compact stat block and a list of rows. */
export default function DashboardLoading() {
  return (
    <div role="status" aria-label="Loading dashboard">
      <div className="mb-6 flex flex-col gap-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-52" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 md:p-5">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-12 w-48" />
          <Skeleton className="h-2 w-full rounded-full" />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 md:p-5 lg:row-span-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="mt-2 h-14 w-full md:w-48" />
        </div>

        <div className="flex flex-col gap-2">
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-xl" />
          ))}
        </div>
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
