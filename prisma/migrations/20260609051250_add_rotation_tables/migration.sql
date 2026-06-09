-- CreateTable
CREATE TABLE "RotationGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "RotationItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "rotationGroupId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT,
    "position" INTEGER NOT NULL,
    "imageUrl" TEXT,
    "price" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RotationItem_rotationGroupId_fkey" FOREIGN KEY ("rotationGroupId") REFERENCES "RotationGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SubscriptionInstance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "subscriptionContractId" TEXT NOT NULL,
    "rotationGroupId" TEXT NOT NULL,
    "currentPosition" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "nextRotationDate" DATETIME,
    "lastRotatedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SubscriptionInstance_rotationGroupId_fkey" FOREIGN KEY ("rotationGroupId") REFERENCES "RotationGroup" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RotationLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "subscriptionInstanceId" TEXT NOT NULL,
    "fromProductId" TEXT,
    "fromProductTitle" TEXT,
    "toProductId" TEXT NOT NULL,
    "toProductTitle" TEXT NOT NULL,
    "rotatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'SUCCESS',
    "errorMessage" TEXT,
    "triggeredBy" TEXT NOT NULL DEFAULT 'SCHEDULED',
    CONSTRAINT "RotationLog_subscriptionInstanceId_fkey" FOREIGN KEY ("subscriptionInstanceId") REFERENCES "SubscriptionInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "RotationGroup_shop_idx" ON "RotationGroup"("shop");

-- CreateIndex
CREATE INDEX "RotationItem_rotationGroupId_idx" ON "RotationItem"("rotationGroupId");

-- CreateIndex
CREATE INDEX "SubscriptionInstance_shop_idx" ON "SubscriptionInstance"("shop");

-- CreateIndex
CREATE INDEX "SubscriptionInstance_rotationGroupId_idx" ON "SubscriptionInstance"("rotationGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionInstance_shop_subscriptionContractId_key" ON "SubscriptionInstance"("shop", "subscriptionContractId");

-- CreateIndex
CREATE INDEX "RotationLog_shop_idx" ON "RotationLog"("shop");

-- CreateIndex
CREATE INDEX "RotationLog_subscriptionInstanceId_idx" ON "RotationLog"("subscriptionInstanceId");
