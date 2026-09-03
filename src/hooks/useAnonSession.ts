import { useQuery } from "@tanstack/react-query";

import { ensureAnonSession } from "@/lib/session";

export function useAnonSession() {
  return useQuery({
    queryKey: ["anon-session"],
    queryFn: ensureAnonSession,
    staleTime: Infinity,
    retry: 1,
  });
}
