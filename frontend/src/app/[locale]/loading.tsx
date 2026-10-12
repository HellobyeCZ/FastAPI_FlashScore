import { Skeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <div aria-busy="true" className="flex flex-col gap-6">
      <Skeleton className="h-8 w-64" />
      <div className="grid gap-px sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
      <Skeleton lines={8} />
    </div>
  );
}
