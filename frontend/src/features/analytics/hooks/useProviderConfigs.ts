import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { adminDashboardQueryKeys } from "./useAdminDashboard";
import { providerConfigService } from "../services/providerConfigService";
import type { LlmProviderConfigInput } from "../types";

export const providerConfigQueryKeys = {
  providers: ["admin-dashboard", "providers"] as const,
  models: ["admin-dashboard", "models"] as const,
};

export const useProviderConfigs = () => {
  return useQuery({
    queryKey: providerConfigQueryKeys.providers,
    queryFn: providerConfigService.getProviders,
  });
};

export const useCreateProviderConfig = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: LlmProviderConfigInput) => providerConfigService.createProvider(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: providerConfigQueryKeys.providers });
      void queryClient.invalidateQueries({ queryKey: adminDashboardQueryKeys.summaryRoot });
      void queryClient.invalidateQueries({ queryKey: adminDashboardQueryKeys.systemStatus });
    },
  });
};

export const useUpdateProviderConfig = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, input }: { id: number; input: LlmProviderConfigInput }) =>
      providerConfigService.updateProvider(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: providerConfigQueryKeys.providers });
      void queryClient.invalidateQueries({ queryKey: adminDashboardQueryKeys.summaryRoot });
      void queryClient.invalidateQueries({ queryKey: adminDashboardQueryKeys.systemStatus });
    },
  });
};

export const useDeleteProviderConfig = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: number) => providerConfigService.deleteProvider(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: providerConfigQueryKeys.providers });
      void queryClient.invalidateQueries({ queryKey: adminDashboardQueryKeys.summaryRoot });
      void queryClient.invalidateQueries({ queryKey: adminDashboardQueryKeys.systemStatus });
    },
  });
};

export const useTestProviderConfig = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: number) => providerConfigService.testProvider(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: providerConfigQueryKeys.models });
      void queryClient.invalidateQueries({ queryKey: adminDashboardQueryKeys.summaryRoot });
      void queryClient.invalidateQueries({ queryKey: adminDashboardQueryKeys.systemStatus });
    },
  });
};

export const usePullProviderModel = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, model }: { id: number; model: string }) =>
      providerConfigService.pullProviderModel(id, model),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: providerConfigQueryKeys.models });
      void queryClient.invalidateQueries({ queryKey: adminDashboardQueryKeys.summaryRoot });
      void queryClient.invalidateQueries({ queryKey: adminDashboardQueryKeys.systemStatus });
    },
  });
};
