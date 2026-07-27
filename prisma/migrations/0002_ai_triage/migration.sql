-- Phase 2 AI-triage tables. Both are 1:1 with an item (unique itemId) and cascade
-- when the item is deleted; `model` records which Claude model produced the row.

-- CreateEnum
CREATE TYPE "ClarificationStatus" AS ENUM ('open', 'resolved', 'dismissed');

-- CreateTable
CREATE TABLE "item_summaries" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "item_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_clarification_requests" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "status" "ClarificationStatus" NOT NULL DEFAULT 'open',
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "item_clarification_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "item_summaries_itemId_key" ON "item_summaries"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "item_clarification_requests_itemId_key" ON "item_clarification_requests"("itemId");

-- AddForeignKey
ALTER TABLE "item_summaries" ADD CONSTRAINT "item_summaries_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_clarification_requests" ADD CONSTRAINT "item_clarification_requests_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
