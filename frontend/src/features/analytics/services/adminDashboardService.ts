import axiosClient from "../../../lib/axiosClient";
import type { ApiResponse } from "../../../types/api";
import type {
  AdminAnalyticsSummary,
  AdminSystemStatus,
  AdminUserPreview,
  LlmModelListResult,
} from "../types";
import { providerConfigService } from "./providerConfigService";

const USER_PREVIEW_LIMIT = 8;

export interface AnalyticsSummaryParams {
  from?: string;
  to?: string;
}

export const adminDashboardService = {
  getProviders: providerConfigService.getProviders,

  async getModelRegistry(): Promise<LlmModelListResult> {
    const { data } = await axiosClient.get<ApiResponse<LlmModelListResult>>("/llm/models");

    return data.data;
  },

  async getUserPreview(): Promise<AdminUserPreview[]> {
    const { data } = await axiosClient.get<ApiResponse<AdminUserPreview[]>>("/users", {
      params: { take: USER_PREVIEW_LIMIT },
    });

    return data.data;
  },

  async getAnalyticsSummary(params: AnalyticsSummaryParams = {}): Promise<AdminAnalyticsSummary> {
    const { data } = await axiosClient.get<ApiResponse<AdminAnalyticsSummary>>(
      "/admin/analytics/summary",
      { params },
    );

    return data.data;
  },

  async getSystemStatus(): Promise<AdminSystemStatus> {
    const { data } = await axiosClient.get<ApiResponse<AdminSystemStatus>>(
      "/admin/system/status",
    );

    return data.data;
  },
};
