// Prisma-backed AssistantStore — the production adapter behind assistantService's
// persistence port. getOrCreateThread keys on the (workspace, channel, threadTs)
// composite the schema marks @@unique, so re-entering the same Slack assistant
// thread returns the same row and its accumulated history.

import type { AssistantMessage, AssistantThread, PrismaClient } from "@prisma/client";
import type { AssistantStore, GetOrCreateThreadInput } from "../services/assistantService";

export function createPrismaAssistantStore(prisma: PrismaClient): AssistantStore {
  return {
    async getOrCreateThread(input: GetOrCreateThreadInput): Promise<AssistantThread> {
      const existing = await prisma.assistantThread.findUnique({
        where: {
          workspaceId_slackChannelId_slackThreadTs: {
            workspaceId: input.workspaceId,
            slackChannelId: input.slackChannelId,
            slackThreadTs: input.slackThreadTs,
          },
        },
      });
      if (existing) return existing;
      return prisma.assistantThread.create({
        data: {
          workspaceId: input.workspaceId,
          appUserId: input.appUserId,
          slackChannelId: input.slackChannelId,
          slackThreadTs: input.slackThreadTs,
        },
      });
    },

    async setContextChannel(threadId: string, contextChannelId: string | null): Promise<void> {
      await prisma.assistantThread.update({
        where: { id: threadId },
        data: { contextChannelId },
      });
    },

    addMessage(threadId: string, role: "user" | "assistant", content: string): Promise<AssistantMessage> {
      return prisma.assistantMessage.create({
        data: { assistantThreadId: threadId, role, content },
      });
    },

    getMessages(threadId: string): Promise<AssistantMessage[]> {
      return prisma.assistantMessage.findMany({
        where: { assistantThreadId: threadId },
        orderBy: { createdAt: "asc" },
      });
    },

    async touch(threadId: string, at: Date): Promise<void> {
      await prisma.assistantThread.update({
        where: { id: threadId },
        data: { lastActiveAt: at },
      });
    },
  };
}
