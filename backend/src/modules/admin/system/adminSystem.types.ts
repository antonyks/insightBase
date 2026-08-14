export interface AdminAnalyticsSummaryInput {
  from?: unknown;
  to?: unknown;
}

export interface AdminAnalyticsSummary {
  period: {
    from: string | null;
    to: string | null;
  };
  providers: {
    total: number;
    active: number;
    disabled: number;
  };
  users: {
    total: number;
    active: number;
    banned: number;
    deleted: number;
    review: number;
  };
  generation: {
    total: number;
    succeeded: number;
    failed: number;
    aborted: number;
    successRate: number;
    failureRate: number;
    abortRate: number;
    averageLatencyMs: number | null;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  jobs: {
    total: number;
    current: {
      queued: number;
      running: number;
      cancelRequested: number;
      cancelled: number;
      succeeded: number;
      failed: number;
    };
    finalized: {
      total: number;
      succeeded: number;
      failed: number;
      cancelled: number;
    };
    averageQueueWaitMs: number | null;
    averageExecutionDurationMs: number | null;
    averageAttempts: number | null;
  };
  providerHealth: {
    total: number;
    success: number;
    error: number;
    skipped: number;
    errorRate: number;
    averageLatencyMs: number | null;
    latestSampleAt: string | null;
  };
}

export interface AdminSystemStatus {
  backend: {
    status: 'online';
  };
  database: {
    status: 'online' | 'error';
    errorMessage?: string;
  };
  inference: {
    status: 'online' | 'review' | 'offline';
    providers: number;
    errors: number;
    skipped: number;
  };
}
