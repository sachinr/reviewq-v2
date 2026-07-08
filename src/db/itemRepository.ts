// Prisma-backed ItemRepository — the production adapter behind the ItemRepository
// port that itemService depends on. All the interesting queue rules live in the
// service and are unit-tested with FakeItemRepository; this file only maps those
// calls onto Prisma queries, so it stays deliberately thin.

import type { Item, PrismaClient } from "@prisma/client";
import type { CreateItemData, ItemRepository, ItemTriageRow } from "../services/ports";

export function createPrismaItemRepository(prisma: PrismaClient): ItemRepository {
  return {
    findByChannelAndTs(channelId: string, slackMessageTs: string): Promise<Item | null> {
      return prisma.item.findUnique({
        where: { channelId_slackMessageTs: { channelId, slackMessageTs } },
      });
    },

    findById(id: string): Promise<Item | null> {
      return prisma.item.findUnique({ where: { id } });
    },

    create(data: CreateItemData): Promise<Item> {
      return prisma.item.create({
        data: {
          workspaceId: data.workspaceId,
          channelId: data.channelId,
          slackMessageTs: data.slackMessageTs,
          slackThreadTs: data.slackThreadTs ?? null,
          messageText: data.messageText ?? null,
          permalink: data.permalink ?? null,
          filesJson: data.filesJson ?? null,
          authorSlackId: data.authorSlackId,
          authorUserId: data.authorUserId ?? null,
          flaggedByUserId: data.flaggedByUserId,
        },
      });
    },

    markComplete(id: string, completedByUserId: string, completedAt: Date): Promise<Item> {
      return prisma.item.update({
        where: { id },
        data: { status: "complete", completedByUserId, completedAt },
      });
    },

    markOpen(id: string): Promise<Item> {
      return prisma.item.update({
        where: { id },
        data: { status: "open", completedByUserId: null, completedAt: null },
      });
    },

    findOpenByChannel(channelId: string): Promise<Item[]> {
      return prisma.item.findMany({
        where: { channelId, status: "open" },
        orderBy: { createdAt: "asc" },
      });
    },

    findRecentlyClosedByChannel(channelId: string, since: Date): Promise<Item[]> {
      return prisma.item.findMany({
        where: { channelId, status: "complete", completedAt: { gte: since } },
        orderBy: { createdAt: "asc" },
      });
    },

    async countOpenByChannelIds(channelIds: string[]): Promise<Array<{ channelId: string; count: number }>> {
      if (channelIds.length === 0) return [];
      const groups = await prisma.item.groupBy({
        by: ["channelId"],
        where: { channelId: { in: channelIds }, status: "open" },
        _count: { _all: true },
      });
      return groups.map((g) => ({ channelId: g.channelId, count: g._count._all }));
    },

    async findTriageByItemIds(itemIds: string[]): Promise<ItemTriageRow[]> {
      if (itemIds.length === 0) return [];
      const rows = await prisma.item.findMany({
        where: {
          id: { in: itemIds },
          OR: [{ summary: { isNot: null } }, { clarification: { isNot: null } }],
        },
        select: {
          id: true,
          summary: { select: { summary: true } },
          clarification: { select: { question: true, status: true } },
        },
      });
      return rows.map((r) => ({
        itemId: r.id,
        summary: r.summary?.summary ?? null,
        clarificationQuestion: r.clarification?.question ?? null,
        clarificationStatus: r.clarification?.status ?? null,
      }));
    },

    async countOpenClarificationsByChannelIds(
      channelIds: string[],
    ): Promise<Array<{ channelId: string; count: number }>> {
      if (channelIds.length === 0) return [];
      const groups = await prisma.item.groupBy({
        by: ["channelId"],
        where: {
          channelId: { in: channelIds },
          status: "open",
          clarification: { is: { status: "open" } },
        },
        _count: { _all: true },
      });
      return groups.map((g) => ({ channelId: g.channelId, count: g._count._all }));
    },
  };
}
