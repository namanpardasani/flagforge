-- CreateEnum
CREATE TYPE "ExperimentStatus" AS ENUM ('DRAFT', 'RUNNING', 'STOPPED');

-- CreateTable
CREATE TABLE "Experiment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "flagId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hypothesis" TEXT,
    "metricKey" TEXT NOT NULL,
    "status" "ExperimentStatus" NOT NULL DEFAULT 'DRAFT',
    "startedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Experiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExperimentExposure" (
    "experimentId" TEXT NOT NULL,
    "userHash" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "variant" BOOLEAN NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExperimentExposure_pkey" PRIMARY KEY ("experimentId","userHash")
);

-- CreateTable
CREATE TABLE "ExperimentConversion" (
    "experimentId" TEXT NOT NULL,
    "userHash" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExperimentConversion_pkey" PRIMARY KEY ("experimentId","userHash")
);

-- CreateIndex
CREATE INDEX "Experiment_workspaceId_idx" ON "Experiment"("workspaceId");

-- CreateIndex
CREATE INDEX "Experiment_projectId_idx" ON "Experiment"("projectId");

-- CreateIndex
CREATE INDEX "Experiment_environmentId_status_idx" ON "Experiment"("environmentId", "status");

-- CreateIndex
CREATE INDEX "ExperimentExposure_workspaceId_idx" ON "ExperimentExposure"("workspaceId");

-- CreateIndex
CREATE INDEX "ExperimentConversion_workspaceId_idx" ON "ExperimentConversion"("workspaceId");

-- AddForeignKey
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_flagId_fkey" FOREIGN KEY ("flagId") REFERENCES "Flag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentExposure" ADD CONSTRAINT "ExperimentExposure_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "Experiment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentConversion" ADD CONSTRAINT "ExperimentConversion_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "Experiment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Added by hand (Prisma cannot express a partial unique index):
-- at most ONE running experiment per flag and environment. Two running at once would both claim
-- the same users, and neither result could be trusted. The database enforces it, so two people
-- pressing "Start" at the same moment cannot both succeed.
CREATE UNIQUE INDEX "Experiment_one_running_per_flag_env" ON "Experiment"("flagId", "environmentId") WHERE "status" = 'RUNNING';
