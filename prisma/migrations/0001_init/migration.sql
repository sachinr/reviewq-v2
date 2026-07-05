-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('channel', 'group', 'im', 'mpim');

-- CreateEnum
CREATE TYPE "ItemStatus" AS ENUM ('open', 'complete');

-- CreateEnum
CREATE TYPE "AssistantMessageRole" AS ENUM ('user', 'assistant');

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "slackTeamId" TEXT NOT NULL,
    "slackEnterpriseId" TEXT,
    "name" TEXT,
    "botUserId" TEXT NOT NULL,
    "botTokenEncrypted" TEXT NOT NULL,
    "botScopes" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_users" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "slackUserId" TEXT NOT NULL,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "userTokenEncrypted" TEXT,
    "isInstaller" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channels" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "slackChannelId" TEXT NOT NULL,
    "name" TEXT,
    "type" "ChannelType" NOT NULL,
    "isBotMember" BOOLEAN NOT NULL DEFAULT false,
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "items" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "slackMessageTs" TEXT NOT NULL,
    "slackThreadTs" TEXT,
    "messageText" TEXT,
    "permalink" TEXT,
    "filesJson" TEXT,
    "sourceMetadataKey" TEXT,
    "authorSlackId" TEXT NOT NULL,
    "authorUserId" TEXT,
    "flaggedByUserId" TEXT NOT NULL,
    "completedByUserId" TEXT,
    "status" "ItemStatus" NOT NULL DEFAULT 'open',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_threads" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "appUserId" TEXT NOT NULL,
    "slackChannelId" TEXT NOT NULL,
    "slackThreadTs" TEXT NOT NULL,
    "contextChannelId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_messages" (
    "id" TEXT NOT NULL,
    "assistantThreadId" TEXT NOT NULL,
    "role" "AssistantMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slackTeamId_key" ON "workspaces"("slackTeamId");

-- CreateIndex
CREATE UNIQUE INDEX "app_users_workspaceId_slackUserId_key" ON "app_users"("workspaceId", "slackUserId");

-- CreateIndex
CREATE UNIQUE INDEX "channels_workspaceId_slackChannelId_key" ON "channels"("workspaceId", "slackChannelId");

-- CreateIndex
CREATE INDEX "items_channelId_status_idx" ON "items"("channelId", "status");

-- CreateIndex
CREATE INDEX "items_workspaceId_status_idx" ON "items"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "items_completedAt_idx" ON "items"("completedAt");

-- CreateIndex
CREATE UNIQUE INDEX "items_channelId_slackMessageTs_key" ON "items"("channelId", "slackMessageTs");

-- CreateIndex
CREATE UNIQUE INDEX "assistant_threads_workspaceId_slackChannelId_slackThreadTs_key" ON "assistant_threads"("workspaceId", "slackChannelId", "slackThreadTs");

-- CreateIndex
CREATE INDEX "assistant_messages_assistantThreadId_createdAt_idx" ON "assistant_messages"("assistantThreadId", "createdAt");

-- AddForeignKey
ALTER TABLE "app_users" ADD CONSTRAINT "app_users_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "app_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_flaggedByUserId_fkey" FOREIGN KEY ("flaggedByUserId") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_completedByUserId_fkey" FOREIGN KEY ("completedByUserId") REFERENCES "app_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_threads" ADD CONSTRAINT "assistant_threads_appUserId_fkey" FOREIGN KEY ("appUserId") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_assistantThreadId_fkey" FOREIGN KEY ("assistantThreadId") REFERENCES "assistant_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

