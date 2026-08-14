-- CreateEnum
CREATE TYPE "GenerationUsageOutcome" AS ENUM ('SUCCEEDED', 'FAILED', 'ABORTED');

-- CreateEnum
CREATE TYPE "GenerationUsageTokenCountSource" AS ENUM ('PROVIDER_REPORTED', 'ESTIMATED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "generation_usages" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "providerId" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "streaming" BOOLEAN NOT NULL,
    "latencyMs" INTEGER,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "totalTokens" INTEGER,
    "tokenCountSource" "GenerationUsageTokenCountSource" NOT NULL DEFAULT 'UNKNOWN',
    "outcome" "GenerationUsageOutcome" NOT NULL,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_usages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "generation_usages_createdAt_idx" ON "generation_usages"("createdAt");

-- CreateIndex
CREATE INDEX "generation_usages_workspaceId_createdAt_idx" ON "generation_usages"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "generation_usages_providerId_createdAt_idx" ON "generation_usages"("providerId", "createdAt");

-- CreateIndex
CREATE INDEX "generation_usages_outcome_createdAt_idx" ON "generation_usages"("outcome", "createdAt");

-- AddForeignKey
ALTER TABLE "generation_usages" ADD CONSTRAINT "generation_usages_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_usages" ADD CONSTRAINT "generation_usages_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "llm_provider_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
