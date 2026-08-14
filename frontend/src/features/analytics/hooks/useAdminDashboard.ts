import { useQuery } from "@tanstack/react-query";
import type { AnalyticsSummaryParams } from "../services/adminDashboardService";
import { adminDashboardService } from "../services/adminDashboardService";

export const adminDashboardQueryKeys = {
  providers: ["admin-dashboard", "providers"] as const,
  models: ["admin-dashboard", "models"] as const,
  users: ["admin-dashboard", "users"] as const,
  summaryRoot: ["admin-dashboard", "summary"] as const,
  summary: (params: AnalyticsSummaryParams = {}) => ["admin-dashboard", "summary", params] as const,
  systemStatus: ["admin-dashboard", "system-status"] as const,
};

export const ADMIN_DASHBOARD_REFRESH_INTERVAL_MS = 60_000;

export const useAdminDashboard = (summaryParams: AnalyticsSummaryParams = {}) => {
  const providersQuery = useQuery({
    queryKey: adminDashboardQueryKeys.providers,
    queryFn: adminDashboardService.getProviders,
  });

  const modelsQuery = useQuery({
    queryKey: adminDashboardQueryKeys.models,
    queryFn: adminDashboardService.getModelRegistry,
  });

  const usersQuery = useQuery({
    queryKey: adminDashboardQueryKeys.users,
    queryFn: adminDashboardService.getUserPreview,
  });

  const summaryQuery = useQuery({
    queryKey: adminDashboardQueryKeys.summary(summaryParams),
    queryFn: () => adminDashboardService.getAnalyticsSummary(summaryParams),
    refetchInterval: ADMIN_DASHBOARD_REFRESH_INTERVAL_MS,
  });

  const systemStatusQuery = useQuery({
    queryKey: adminDashboardQueryKeys.systemStatus,
    queryFn: adminDashboardService.getSystemStatus,
    refetchInterval: ADMIN_DASHBOARD_REFRESH_INTERVAL_MS,
  });

  return {
    providersQuery,
    modelsQuery,
    usersQuery,
    summaryQuery,
    systemStatusQuery,
  };
};

export const useAdminSystemStatus = () => {
  return useQuery({
    queryKey: adminDashboardQueryKeys.systemStatus,
    queryFn: adminDashboardService.getSystemStatus,
    refetchInterval: ADMIN_DASHBOARD_REFRESH_INTERVAL_MS,
  });
};
