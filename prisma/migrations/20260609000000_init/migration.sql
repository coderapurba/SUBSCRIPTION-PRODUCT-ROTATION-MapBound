-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" DATETIME,
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" DATETIME
);

-- CreateTable
CREATE TABLE "ShopSetting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "RotationGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "targetProductId" TEXT NOT NULL,
    "targetProductTitle" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RotationGroup_shop_fkey" FOREIGN KEY ("shop") REFERENCES "ShopSetting" ("shop") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RotationItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "rotationGroupId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT,
    "sortOrder" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
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
    "customerId" TEXT NOT NULL,
    "originalOrderId" TEXT NOT NULL,
    "subscriptionContractId" TEXT,
    "targetProductId" TEXT NOT NULL,
    "currentIndex" INTEGER NOT NULL DEFAULT 0,
    "uniqueKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "rotationGroupId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SubscriptionInstance_rotationGroupId_fkey" FOREIGN KEY ("rotationGroupId") REFERENCES "RotationGroup" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RotationLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "targetProductTitle" TEXT NOT NULL,
    "rotationProductTitle" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUCCESS',
    "message" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopSetting_shop_key" ON "ShopSetting"("shop");

-- CreateIndex
CREATE INDEX "RotationGroup_shop_idx" ON "RotationGroup"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "RotationGroup_shop_targetProductId_key" ON "RotationGroup"("shop", "targetProductId");

-- CreateIndex
CREATE INDEX "RotationItem_rotationGroupId_idx" ON "RotationItem"("rotationGroupId");

-- CreateIndex
CREATE INDEX "RotationItem_rotationGroupId_sortOrder_idx" ON "RotationItem"("rotationGroupId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionInstance_uniqueKey_key" ON "SubscriptionInstance"("uniqueKey");

-- CreateIndex
CREATE INDEX "SubscriptionInstance_shop_idx" ON "SubscriptionInstance"("shop");

-- CreateIndex
CREATE INDEX "SubscriptionInstance_shop_customerId_idx" ON "SubscriptionInstance"("shop", "customerId");

-- CreateIndex
CREATE INDEX "SubscriptionInstance_shop_targetProductId_idx" ON "SubscriptionInstance"("shop", "targetProductId");

-- CreateIndex
CREATE INDEX "SubscriptionInstance_shop_subscriptionContractId_idx" ON "SubscriptionInstance"("shop", "subscriptionContractId");

-- CreateIndex
CREATE INDEX "RotationLog_shop_idx" ON "RotationLog"("shop");

-- CreateIndex
CREATE INDEX "RotationLog_shop_createdAt_idx" ON "RotationLog"("shop", "createdAt");
