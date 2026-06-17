-- Add lastProcessedOrderId to SubscriptionInstance
-- Prevents sequential webhook retries from claiming different rotation slots
-- for the same order (lock records which order was last processed atomically
-- with the index advance, so all later webhook deliveries for that order lose
-- the lock claim even after the index has moved forward)
ALTER TABLE "SubscriptionInstance" ADD COLUMN "lastProcessedOrderId" TEXT;
