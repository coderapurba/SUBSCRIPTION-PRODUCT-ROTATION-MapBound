-- Add stepIndex (renewal-step / batch number) to RotationItem.
-- Nullable: existing rows stay null and are treated as legacy singleton steps
-- (stepOf = stepIndex ?? sortOrder), preserving one-product-per-renewal behavior.
ALTER TABLE "RotationItem" ADD COLUMN "stepIndex" INTEGER;
