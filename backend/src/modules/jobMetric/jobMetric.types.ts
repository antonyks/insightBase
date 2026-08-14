import { JobMetricOutcome } from './jobMetric.model';

export interface JobMetricCreateInput {
  jobId: number;
  workspaceId: number;
  jobType: string;
  outcome: JobMetricOutcome;
  attempts: number;
  queueWaitMs?: number;
  executionDurationMs?: number;
  errorCode?: string;
}
