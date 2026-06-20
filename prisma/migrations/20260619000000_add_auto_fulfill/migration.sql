-- Add autoFulfill to RotationGroup
ALTER TABLE "RotationGroup" ADD COLUMN "autoFulfill" BOOLEAN NOT NULL DEFAULT false;
