// Round-trips the Prisma-backed adapters (ItemRepository, WorkspaceStore,
// AssistantStore) against a REAL Postgres. The pure services are already unit-
// tested with in-memory fakes; this proves the thin mapping onto Prisma actually
// persists and reads back — the @@unique upserts are idempotent, the composite
// keys resolve, status transitions round-trip, and history orders deterministically.
// Gated on DATABASE_URL so it only runs in CI (where the workflow migrates a
// throwaway Postgres first); with no DATABASE_URL the suite is skipped, not failed.

import type { PrismaClient } from "@prisma/client";
import { createPrismaItemRepository } from "../../src/db/itemRepository";
import { createPrismaWorkspaceStore } from "../../src/db/workspaceStore";
import { createPrismaAssistantStore } from "../../src/db/assistantStore";

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

// A run-scoped Slack team id so a leftover row from a crashed run can't collide;
// everything else hangs off the workspace and is removed by its cascade.
const TEAM_ID = "T_INTEG_TEST";

describeIf("Prisma adapters (integration, DATABASE_URL)", () => {
  let prisma: PrismaClient;
  let workspaceId: string;

  beforeAll(async () => {
    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient();
    await prisma.$connect();
    await cleanup(prisma);
    const ws = await prisma.workspace.create({
      data: {
        slackTeamId: TEAM_ID,
        botUserId: "U_BOT",
        botTokenEncrypted: "enc:xxx",
        botScopes: "chat:write",
      },
    });
    workspaceId = ws.id;
  });

  afterAll(async () => {
    if (prisma) {
      await cleanup(prisma);
      await prisma.$disconnect();
    }
  });

  describe("WorkspaceStore", () => {
    it("upserts channels and users idempotently on their composite keys", async () => {
      const store = createPrismaWorkspaceStore(prisma);

      const c1 = await store.upsertChannel({
        workspaceId,
        slackChannelId: "C_LEGAL",
        name: "legal",
        type: "channel",
        isBotMember: true,
        isPrivate: false,
      });
      const c2 = await store.upsertChannel({
        workspaceId,
        slackChannelId: "C_LEGAL",
        name: "legal-renamed",
        type: "channel",
        isBotMember: true,
        isPrivate: false,
      });
      expect(c2.id).toBe(c1.id); // same row, updated in place
      expect(c2.name).toBe("legal-renamed");

      const u1 = await store.upsertUser({ workspaceId, slackUserId: "U_A", displayName: "Ann" });
      const u2 = await store.upsertUser({ workspaceId, slackUserId: "U_A" });
      expect(u2.id).toBe(u1.id);
      // An empty follow-up lookup must not wipe a previously-hydrated name.
      expect(u2.displayName).toBe("Ann");

      const channels = await store.listChannels(workspaceId);
      expect(channels.map((c) => c.slackChannelId)).toContain("C_LEGAL");
    });
  });

  describe("ItemRepository", () => {
    it("creates, finds, completes, reopens, and counts open items", async () => {
      const store = createPrismaWorkspaceStore(prisma);
      const repo = createPrismaItemRepository(prisma);

      const channel = await store.upsertChannel({
        workspaceId,
        slackChannelId: "C_ITEMS",
        name: "items",
        type: "channel",
        isBotMember: true,
        isPrivate: false,
      });
      const flagger = await store.upsertUser({ workspaceId, slackUserId: "U_FLAG", displayName: "Flagger" });

      const created = await repo.create({
        workspaceId,
        channelId: channel.id,
        slackMessageTs: "1700000000.000100",
        slackThreadTs: null,
        messageText: "review this",
        permalink: null,
        filesJson: null,
        authorSlackId: "U_AUTHOR",
        authorUserId: null,
        flaggedByUserId: flagger.id,
      });
      expect(created.status).toBe("open");

      // Composite (channelId, ts) unique key resolves back to the same row.
      const byTs = await repo.findByChannelAndTs(channel.id, "1700000000.000100");
      expect(byTs?.id).toBe(created.id);

      const completedAt = new Date();
      const done = await repo.markComplete(created.id, flagger.id, completedAt);
      expect(done.status).toBe("complete");
      expect(done.completedByUserId).toBe(flagger.id);

      expect(await repo.findOpenByChannel(channel.id)).toHaveLength(0);
      expect(await repo.findRecentlyClosedByChannel(channel.id, new Date(completedAt.getTime() - 1000))).toHaveLength(1);

      const reopened = await repo.markOpen(created.id);
      expect(reopened.status).toBe("open");
      expect(reopened.completedAt).toBeNull();

      const counts = await repo.countOpenByChannelIds([channel.id]);
      expect(counts).toEqual([{ channelId: channel.id, count: 1 }]);
    });
  });

  describe("AssistantStore", () => {
    it("gets-or-creates a thread idempotently and orders messages deterministically", async () => {
      const store = createPrismaWorkspaceStore(prisma);
      const assistant = createPrismaAssistantStore(prisma);
      const user = await store.upsertUser({ workspaceId, slackUserId: "U_ASSIST" });

      const input = {
        workspaceId,
        appUserId: user.id,
        slackChannelId: "D_ASSIST",
        slackThreadTs: "1700000001.000001",
      };
      const t1 = await assistant.getOrCreateThread(input);
      const t2 = await assistant.getOrCreateThread(input);
      expect(t2.id).toBe(t1.id); // re-entering the same Slack thread reuses the row

      await assistant.addMessage(t1.id, "user", "hello");
      await assistant.addMessage(t1.id, "assistant", "hi there");
      const messages = await assistant.getMessages(t1.id);
      expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);

      const at = new Date();
      await assistant.touch(t1.id, at);
      const refreshed = await prisma.assistantThread.findUnique({ where: { id: t1.id } });
      expect(refreshed?.lastActiveAt.getTime()).toBe(at.getTime());
    });
  });
});

// Remove the test workspace and everything under it. Deleted in explicit
// dependency order rather than via the workspace cascade: an Item's FK to its
// flaggedBy AppUser is Restrict (no onDelete cascade), so items must go before
// the app_users a workspace-level cascade would otherwise try to remove first.
async function cleanup(prisma: PrismaClient): Promise<void> {
  const ws = await prisma.workspace.findUnique({ where: { slackTeamId: TEAM_ID } });
  if (!ws) return;
  await prisma.item.deleteMany({ where: { workspaceId: ws.id } });
  await prisma.assistantThread.deleteMany({ where: { workspaceId: ws.id } }); // cascades messages
  await prisma.channel.deleteMany({ where: { workspaceId: ws.id } });
  await prisma.appUser.deleteMany({ where: { workspaceId: ws.id } });
  await prisma.workspace.delete({ where: { id: ws.id } });
}
