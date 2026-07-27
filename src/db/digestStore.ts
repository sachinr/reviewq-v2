// Prisma-backed DigestStore — the production adapter behind the digest job's
// persistence port. recordRun appends a history row (never upsert — every run is
// kept); loadOpenItems maps a channel's open items to the StaleItem shape the
// digest core reads (preferring the AI-triage summary when present);
// listDigestChannels enumerates the channels a sweep should consider — bot is a
// member, workspace is active, and there is at least one open item.

import type { PrismaClient } from "@prisma/client";
import type { DigestChannelRef, DigestStore, RecordedDigestRun } from "../jobs/digestQueue";
import type { StaleItem } from "../services/digest";

export function createPrismaDigestStore(prisma: PrismaClient): DigestStore {
  return {
    async loadOpenItems(channelId: string): Promise<StaleItem[]> {
      const items = await prisma.item.findMany({
        where: { channelId, status: "open" },
        include: { summary: true },
        orderBy: { createdAt: "asc" },
      });
      return items.map((it) => ({
        id: it.id,
        messageText: it.messageText,
        permalink: it.permalink,
        createdAt: it.createdAt,
        summary: it.summary?.summary ?? null,
      }));
    },

    async recordRun(run: RecordedDigestRun): Promise<void> {
      await prisma.digestRun.create({
        data: {
          workspaceId: run.workspaceId,
          channelId: run.channelId,
          itemsConsidered: run.itemsConsidered,
          staleItems: run.staleItems,
          summaryText: run.summaryText,
          postedMessageTs: run.postedMessageTs,
        },
      });
    },

    async listDigestChannels(): Promise<DigestChannelRef[]> {
      const channels = await prisma.channel.findMany({
        where: {
          isBotMember: true,
          workspace: { isActive: true },
          items: { some: { status: "open" } },
        },
        select: { id: true, workspaceId: true, slackChannelId: true },
      });
      return channels.map((c) => ({
        workspaceId: c.workspaceId,
        channelId: c.id,
        slackChannelId: c.slackChannelId,
      }));
    },
  };
}
