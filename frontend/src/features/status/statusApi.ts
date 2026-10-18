import { useQuery } from "@tanstack/react-query";
import { ApiError, apiRequest } from "@/lib/apiClient";

export type Health = { status: "ok"; uptimeSeconds: number; timestamp: string };
export type Readiness = {
  status: "up" | "degraded" | "down";
  components: Record<string, "up" | "degraded" | "down">;
  timestamp: string;
};

export function getHealth(): Promise<Health> {
  return apiRequest("/health");
}

export async function getReadiness(): Promise<Readiness> {
  try {
    return await apiRequest("/ready");
  } catch (error) {
    if (error instanceof ApiError && error.status === 503 && typeof error.details?.components === "object") {
      return error.details as unknown as Readiness;
    }
    throw error;
  }
}

export function useSystemStatus() {
  const health = useQuery({
    queryKey: ["status", "health"],
    queryFn: getHealth,
    refetchInterval: 30_000,
  });
  const readiness = useQuery({
    queryKey: ["status", "ready"],
    queryFn: getReadiness,
    refetchInterval: 30_000,
  });
  return { health, readiness };
}
