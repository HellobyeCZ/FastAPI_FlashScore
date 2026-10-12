"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "@/lib/api/http";

// Terminal design rule: refresh is deliberate. No refetch on window focus;
// pages that need liveness opt in with refetchInterval.
export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            retry: (count, err) => {
              // Don't hammer a backend that answered with a client error.
              if (err instanceof ApiError && err.status >= 400 && err.status < 500) return false;
              return count < 1;
            }
          }
        }
      })
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
