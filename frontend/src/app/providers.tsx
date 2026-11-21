/** Fournisseurs communs : données (TanStack Query), info-bulles, confirmations, notifications. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { ConfirmProvider } from "@/components/ConfirmDialog";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { isApiError } from "@/lib/api/errors";

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        // Les erreurs 4xx sont définitives ; seules les pannes réseau / serveur sont retentées.
        retry: (failureCount, error) =>
          isApiError(error) && error.status > 0 && error.status < 500 ? false : failureCount < 2,
      },
      mutations: { retry: false },
    },
  });
}

export function AppProviders({ children, client }: { children: ReactNode; client?: QueryClient }) {
  const [queryClient] = useState(() => client ?? createQueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={350} skipDelayDuration={150}>
        <ConfirmProvider>{children}</ConfirmProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
