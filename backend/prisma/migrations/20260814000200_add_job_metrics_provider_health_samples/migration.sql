-- CreateEnum
CREATE TYPE "JobMetricOutcome" AS ENUM ('SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProviderHealthSampleOperation" AS ENUM ('MODEL_REGISTRY', 'PROVIDER_TEST');

-- CreateEnum
CREATE TYPE "ProviderHealthSampleStatus" AS ENUM ('SUCCESS', 'ERROR', 'SKIPPED');

-- CreateTable
CREATE TABLE "job_metrics" (
    "id" SERIAL NOT NULL,
    "jobId" INTEGER NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "jobType" TEXT NOT NULL,
    "outcome" "JobMetricOutcome" NOT NULL,
    "attempts" INTEGER NOT NULL,
    "queueWaitMs" INTEGER,
    "executionDurationMs" INTEGER,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_health_samples" (
    "id" SERIAL NOT NULL,
    "providerId" INTEGER NOT NULL,
    "providerType" "LlmProviderConfigType" NOT NULL,
    "operation" "ProviderHealthSampleOperation" NOT NULL,
    "status" "ProviderHealthSampleStatus" NOT NULL,
    "latencyMs" INTEGER,
    "modelCount" INTEGER,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_health_samples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "job_metrics_jobId_key" ON "job_metrics"("jobId");

-- CreateIndex
CREATE INDEX "job_metrics_workspaceId_createdAt_idx" ON "job_metrics"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "job_metrics_jobType_createdAt_idx" ON "job_metrics"("jobType", "createdAt");

-- CreateIndex
CREATE INDEX "job_metrics_outcome_createdAt_idx" ON "job_metrics"("outcome", "createdAt");

-- CreateIndex
CREATE INDEX "provider_health_samples_providerId_createdAt_idx" ON "provider_health_samples"("providerId", "createdAt");

-- CreateIndex
CREATE INDEX "provider_health_samples_providerType_createdAt_idx" ON "provider_health_samples"("providerType", "createdAt");

-- CreateIndex
CREATE INDEX "provider_health_samples_operation_createdAt_idx" ON "provider_health_samples"("operation", "createdAt");

-- CreateIndex
CREATE INDEX "provider_health_samples_status_createdAt_idx" ON "provider_health_samples"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "job_metrics" ADD CONSTRAINT "job_metrics_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_metrics" ADD CONSTRAINT "job_metrics_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_health_samples" ADD CONSTRAINT "provider_health_samples_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "llm_provider_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
