import { Skeleton } from "@/components/ui/skeleton";

const CARDS_PER_COLUMN = [3, 2, 3, 1, 2];

export default function PipelineLoading() {
  return (
    <div role="status" aria-label="Loading pipeline">
      <div className="mb-6 flex flex-col gap-2">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-4 w-28" />
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        <Skeleton className="h-12 w-44" />
        <Skeleton className="h-12 w-36" />
      </div>

      <div className="-mx-4 flex gap-3 overflow-hidden px-4 pb-4 md:mx-0 md:px-0">
        {CARDS_PER_COLUMN.map((cards, column) => (
          <div key={column} className="flex w-[85vw] max-w-sm shrink-0 flex-col rounded-xl border sm:w-80 md:w-72">
            <div className="flex h-12 items-center justify-between border-b px-3">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-6" />
            </div>
            <div className="flex flex-col gap-2 p-2">
              {Array.from({ length: cards }, (_, i) => (
                <div key={i} className="flex flex-col gap-2 rounded-lg border bg-card p-3">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-28" />
                  <div className="flex justify-between">
                    <Skeleton className="h-3 w-24" />
                    <Skeleton className="h-3 w-10" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
