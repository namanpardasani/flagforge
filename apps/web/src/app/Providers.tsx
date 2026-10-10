import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ShellProvider } from "@/components/shell/shell-state";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MotionProvider } from "@/motion";

/** Everything the app needs around it, in one place. Tests wrap components in this too. */
export function Providers({ children }: { children: ReactNode }) {
  // Created inside state so every app instance (and every test) gets its own cache.
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false, refetchOnWindowFocus: false } } }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <MotionProvider>
        <TooltipProvider delayDuration={250}>
          <ShellProvider>{children}</ShellProvider>
        </TooltipProvider>
      </MotionProvider>
    </QueryClientProvider>
  );
}
