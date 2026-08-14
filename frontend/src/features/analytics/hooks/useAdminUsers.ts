import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { adminDashboardQueryKeys } from "./useAdminDashboard";
import { adminUserService } from "../services/adminUserService";
import type {
  AdminUserCreateInput,
  AdminUserListParams,
  AdminUserUpdateInput,
} from "../types";

export const adminUserQueryKeys = {
  all: ["admin-users"] as const,
  lists: () => [...adminUserQueryKeys.all, "list"] as const,
  list: (params: AdminUserListParams) => [...adminUserQueryKeys.lists(), params] as const,
  details: () => [...adminUserQueryKeys.all, "detail"] as const,
  detail: (id: number) => [...adminUserQueryKeys.details(), id] as const,
};

export const useAdminUsers = (params: AdminUserListParams) => {
  return useQuery({
    queryKey: adminUserQueryKeys.list(params),
    queryFn: () => adminUserService.getUsers(params),
  });
};

export const useAdminUser = (id: number | null) => {
  return useQuery({
    queryKey: id ? adminUserQueryKeys.detail(id) : [...adminUserQueryKeys.details(), "none"],
    queryFn: () => adminUserService.getUser(id as number),
    enabled: id !== null,
  });
};

export const useCreateAdminUser = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: AdminUserCreateInput) => adminUserService.createUser(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminUserQueryKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: adminDashboardQueryKeys.users });
      void queryClient.invalidateQueries({ queryKey: adminDashboardQueryKeys.summaryRoot });
    },
  });
};

export const useUpdateAdminUser = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, input }: { id: number; input: AdminUserUpdateInput }) =>
      adminUserService.updateUser(id, input),
    onSuccess: (user) => {
      void queryClient.invalidateQueries({ queryKey: adminUserQueryKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: adminUserQueryKeys.detail(user.id) });
      void queryClient.invalidateQueries({ queryKey: adminDashboardQueryKeys.users });
      void queryClient.invalidateQueries({ queryKey: adminDashboardQueryKeys.summaryRoot });
    },
  });
};

const useUserStatusMutation = (mutationFn: (id: number) => Promise<unknown>) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn,
    onSuccess: (_result, id) => {
      void queryClient.invalidateQueries({ queryKey: adminUserQueryKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: adminUserQueryKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: adminDashboardQueryKeys.users });
      void queryClient.invalidateQueries({ queryKey: adminDashboardQueryKeys.summaryRoot });
    },
  });
};

export const useBanAdminUser = () => {
  return useUserStatusMutation((id) => adminUserService.banUser(id));
};

export const useActivateAdminUser = () => {
  return useUserStatusMutation((id) => adminUserService.activateUser(id));
};

export const useDeleteAdminUser = () => {
  return useUserStatusMutation((id) => adminUserService.deleteUser(id));
};
