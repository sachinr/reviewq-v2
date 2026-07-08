import {
  ASSISTANT_TOOLS,
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
