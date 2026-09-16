import { Skeleton } from "@/components/ui/skeleton";

export default function PhoneNumbersLoading() {
  return (
    <div role="status" aria-label="Loading phone numbers">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-36" />
        </div>
        <Skeleton className="h-12 w-36" />
      </div>

      <div className="hidden overflow-hidden rounded-xl border bg-card md:block">
        <Skeleton className="h-11 w-full rounded-none" />
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex h-16 items-center gap-6 border-t px-4">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-6 w-16 rounded-full" />
            <Skeleton className="ml-auto h-4 w-8" />
            <Skeleton className="h-12 w-28" />
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2 md:hidden">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="flex flex-col gap-3 rounded-xl border bg-card p-4">
            <div className="flex justify-between gap-3">
              <Skeleton className="h-5 w-36" />
              <Skeleton className="h-6 w-16 rounded-full" />
            </div>
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-12 w-full" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
