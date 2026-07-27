import {
  ASSISTANT_TOOLS,
  createChannelReadAccess,
  executeToolCall,
  executeToolPlan,
  type ToolCall,
  type ToolExecContext,
} from "../../src/services/assistantTools";
import type { ChannelContext } from "../../src/services/ports";
import { createItemService } from "../../src/services/itemService";
import { FakeItemRepository, FakeSlackGateway, makeItem } from "../fakes";

const channel: ChannelContext = {
  id: "chan_legal",
  workspaceId: "ws_1",
  slackChannelId: "C_LEGAL",
  isBotMember: true,
  type: "channel",
};

/** Build an exec context whose membership oracle admits only `accessible` channels. */
function buildCtx(opts: { accessible: string[]; channels: Record<string, ChannelContext> }) {
  const repo = new FakeItemRepository();
  const slack = new FakeSlackGateway();
  const items = createItemService({ repo, slack });
  const accessible = new Set(opts.accessible);

  const ctx: ToolExecContext = {
    workspaceId: "ws_1",
    requestingSlackId: "U_REQ",
    canAccessChannel: (id) => accessible.has(id),
    resolveChannel: async (id) => opts.channels[id] ?? null,
    items,
  };
  return { ctx, repo, slack };
}

describe("assistantTools executor — authorization boundary", () => {
  it("lists open items for a channel the requesting user belongs to", async () => {
    const { ctx, repo } = buildCtx({ accessible: ["C_LEGAL"], channels: { C_LEGAL: channel } });
    repo.seed(
      makeItem({ id: "i1", channelId: "chan_legal", status: "open", messageText: "review NDA" }),
      makeItem({ id: "i2", channelId: "chan_legal", status: "complete", completedAt: new Date() }),
    );

    const outcome = await executeToolCall(
      { name: "list_open_items", input: { channelId: "C_LEGAL" } },
      ctx,
    );

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("unreachable");
    const result = outcome.result as { items: Array<{ id: string; text: string | null }> };
    expect(result.items.map((i) => i.id)).toEqual(["i1"]); // only the open item
    expect(result.items[0].text).toBe("review NDA");
  });

  it("refuses to list a channel the requesting user is NOT a member of", async () => {
    const finance: ChannelContext = { ...channel, id: "chan_fin", slackChannelId: "C_FINANCE" };
    const { ctx } = buildCtx({
      accessible: ["C_LEGAL"], // user is in legal, but asks for finance
      channels: { C_LEGAL: channel, C_FINANCE: finance },
    });

    const outcome = await executeToolCall(
      { name: "list_open_items", input: { channelId: "C_FINANCE" } },
      ctx,
    );

    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") throw new Error("unreachable");
    expect(outcome.reason).toMatch(/not a member/i);
  });

  it("refuses a list with no channel id", async () => {
    const { ctx } = buildCtx({ accessible: [], channels: {} });
    const outcome = await executeToolCall({ name: "list_open_items", input: {} }, ctx);
    expect(outcome.status).toBe("refused");
  });

  it("refuses an unknown tool name", async () => {
    const { ctx } = buildCtx({ accessible: [], channels: {} });
    const outcome = await executeToolCall({ name: "delete_everything", input: {} }, ctx);
    expect(outcome.status).toBe("refused");
  });
});

describe("assistantTools executor — mutation containment", () => {
  it("never executes complete_item directly — defers to a confirmation proposal", async () => {
    const { ctx, slack } = buildCtx({ accessible: ["C_LEGAL"], channels: { C_LEGAL: channel } });

    const outcome = await executeToolCall(
      { name: "complete_item", input: { itemId: "i1" } },
      ctx,
    );

    expect(outcome.status).toBe("needs_confirmation");
    if (outcome.status !== "needs_confirmation") throw new Error("unreachable");
    expect(outcome.proposal).toEqual({ toolName: "complete_item", input: { itemId: "i1" } });
    // Nothing was mutated: no reaction, no DM went out.
    expect(slack.calls).toHaveLength(0);
  });

  it("never executes undo_complete directly either", async () => {
    const { ctx } = buildCtx({ accessible: ["C_LEGAL"], channels: { C_LEGAL: channel } });
    const outcome = await executeToolCall({ name: "undo_complete", input: { itemId: "i1" } }, ctx);
    expect(outcome.status).toBe("needs_confirmation");
  });

  it("invariant: no mutating tool ever returns an `ok` outcome", async () => {
    const { ctx } = buildCtx({ accessible: ["C_LEGAL"], channels: { C_LEGAL: channel } });
    const mutating = ASSISTANT_TOOLS.filter((t) => t.mutating);
    const calls: ToolCall[] = mutating.map((t) => ({ name: t.name, input: { itemId: "x" } }));
    const outcomes = await executeToolPlan(calls, ctx);
    expect(outcomes.every((o) => o.status !== "ok")).toBe(true);
  });
});

describe("createChannelReadAccess — cross-channel read boundary", () => {
  const legal: ChannelContext = { ...channel };
  const finance: ChannelContext = { ...channel, id: "chan_fin", slackChannelId: "C_FINANCE" };
  const secret: ChannelContext = { ...channel, id: "chan_secret", slackChannelId: "C_SECRET" };

  it("admits and resolves the in-context channel without calling resolveOther", async () => {
    let resolveOtherCalls = 0;
    const access = createChannelReadAccess({
      contextChannelId: "C_LEGAL",
      contextChannel: legal,
      memberChannelIds: [], // no user token: only the in-context channel is known
      resolveOther: async () => {
        resolveOtherCalls += 1;
        return null;
      },
    });

    expect(access.canAccessChannel("C_LEGAL")).toBe(true);
    expect(await access.resolveChannel("C_LEGAL")).toBe(legal);
    expect(resolveOtherCalls).toBe(0); // served from the seeded context channel
  });

  it("admits a channel the user is a member of and resolves it via resolveOther, caching the result", async () => {
    let resolveOtherCalls = 0;
    const access = createChannelReadAccess({
      contextChannelId: "C_LEGAL",
      contextChannel: legal,
      memberChannelIds: ["C_LEGAL", "C_FINANCE"],
      resolveOther: async (id) => {
        resolveOtherCalls += 1;
        return id === "C_FINANCE" ? finance : null;
      },
    });

    expect(access.canAccessChannel("C_FINANCE")).toBe(true);
    expect(await access.resolveChannel("C_FINANCE")).toBe(finance);
    expect(await access.resolveChannel("C_FINANCE")).toBe(finance); // second call
    expect(resolveOtherCalls).toBe(1); // resolved once, then cached
  });

  it("refuses a channel the user is not a member of — and never resolves it", async () => {
    let resolveOtherCalls = 0;
    const access = createChannelReadAccess({
      contextChannelId: "C_LEGAL",
      contextChannel: legal,
      memberChannelIds: ["C_LEGAL"],
      resolveOther: async () => {
        resolveOtherCalls += 1;
        return secret; // even if the resolver *could* find it, access must gate first
      },
    });

    expect(access.canAccessChannel("C_SECRET")).toBe(false);
    expect(await access.resolveChannel("C_SECRET")).toBeNull();
    expect(resolveOtherCalls).toBe(0); // boundary short-circuits before any resolve
  });

  it("keeps the in-context channel readable even with no membership set (no user token)", async () => {
    const access = createChannelReadAccess({
      contextChannelId: "C_LEGAL",
      contextChannel: legal,
      resolveOther: async () => null,
    });
    expect(access.canAccessChannel("C_LEGAL")).toBe(true);
    expect(access.canAccessChannel("C_FINANCE")).toBe(false);
  });

  it("plugs into the executor: a member channel read succeeds, a non-member read is refused", async () => {
    const repo = new FakeItemRepository();
    repo.seed(makeItem({ id: "f1", channelId: "chan_fin", status: "open", messageText: "audit" }));
    const items = createItemService({ repo, slack: new FakeSlackGateway() });
    const access = createChannelReadAccess({
      contextChannelId: "C_LEGAL",
      contextChannel: legal,
      memberChannelIds: ["C_LEGAL", "C_FINANCE"],
      resolveOther: async (id) => (id === "C_FINANCE" ? finance : null),
    });
    const ctx: ToolExecContext = {
      workspaceId: "ws_1",
      requestingSlackId: "U_REQ",
      canAccessChannel: access.canAccessChannel,
      resolveChannel: access.resolveChannel,
      items,
    };

    const ok = await executeToolCall({ name: "list_open_items", input: { channelId: "C_FINANCE" } }, ctx);
    expect(ok.status).toBe("ok");
    if (ok.status !== "ok") throw new Error("unreachable");
    expect((ok.result as { items: Array<{ id: string }> }).items.map((i) => i.id)).toEqual(["f1"]);

    const refused = await executeToolCall({ name: "list_open_items", input: { channelId: "C_SECRET" } }, ctx);
    expect(refused.status).toBe("refused");
  });
});
