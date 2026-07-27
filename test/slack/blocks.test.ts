import {
  ACTION_ASSISTANT_CONFIRM,
  ACTION_ASSISTANT_DISMISS,
  digestBlocks,
  homeView,
  mutationConfirmBlocks,
} from "../../src/slack/blocks";

describe("digestBlocks", () => {
  it("renders the digest prose under a header that counts the stale items (pluralized)", () => {
    const text = JSON.stringify(digestBlocks("Two contracts are stuck.", 3));
    expect(text).toContain("Two contracts are stuck.");
    expect(text).toContain("3 items have");
    expect(text).toContain("digest");
  });

  it("uses singular wording for a single stale item", () => {
    const text = JSON.stringify(digestBlocks("One thing is stuck.", 1));
    expect(text).toContain("1 item has");
  });
});

describe("homeView", () => {
  it("renders an auth prompt when the viewer has no user token", () => {
    const { type, blocks } = homeView("Reviewed", { kind: "authNeeded" });
    expect(type).toBe("home");
    const text = JSON.stringify(blocks);
    expect(text).toMatch(/Connect your account/i);
    // No channel rows leak in the auth state.
    expect(text).not.toMatch(/open item/i);
  });

  it("lists only channels with open items, formatted with a channel mention", () => {
    const { blocks } = homeView("Reviewed", {
      kind: "channels",
      channels: [
        { slackChannelId: "C_LEGAL", name: "legal", openCount: 3 },
        { slackChannelId: "C_EMPTY", name: "empty", openCount: 0 },
        { slackChannelId: "C_ONE", name: "one", openCount: 1 },
      ],
    });
    const text = JSON.stringify(blocks);
    expect(text).toContain("<#C_LEGAL>");
    expect(text).toContain("3 open items");
    expect(text).toContain("<#C_ONE>");
    expect(text).toContain("1 open item"); // singular
    // The zero-count channel is omitted.
    expect(text).not.toContain("<#C_EMPTY>");
  });

  it("flags how many open items in a channel still need clarification", () => {
    const { blocks } = homeView("Reviewed", {
      kind: "channels",
      channels: [
        { slackChannelId: "C_LEGAL", name: "legal", openCount: 4, clarificationCount: 2 },
        { slackChannelId: "C_CLEAR", name: "clear", openCount: 3, clarificationCount: 0 },
      ],
    });
    const text = JSON.stringify(blocks);
    expect(text).toContain("2 need clarification");
    // A channel with no clarifications shows just its open count, no suffix.
    expect(text).not.toContain("0 need");
  });

  it("uses the singular for a single item needing clarification", () => {
    const { blocks } = homeView("Reviewed", {
      kind: "channels",
      channels: [{ slackChannelId: "C_ONE", name: "one", openCount: 2, clarificationCount: 1 }],
    });
    expect(JSON.stringify(blocks)).toContain("1 needs clarification");
  });

  it("shows an all-clear message when no channel has open items", () => {
    const { blocks } = homeView("Reviewed", {
      kind: "channels",
      channels: [{ slackChannelId: "C_EMPTY", name: "empty", openCount: 0 }],
    });
    expect(JSON.stringify(blocks)).toMatch(/All clear/i);
  });
});

describe("mutationConfirmBlocks", () => {
  const base = { itemId: "i1", slackChannelId: "C_LEGAL", label: "review the NDA" };

  it("renders a confirm + cancel pair whose values carry only controlled ids", () => {
    const blocks = mutationConfirmBlocks({ kind: "complete", ...base });
    const actions = blocks.find((b) => b.type === "actions") as { elements: Array<{ action_id: string; value: string }> };
    expect(actions.elements.map((e) => e.action_id)).toEqual([
      ACTION_ASSISTANT_CONFIRM,
      ACTION_ASSISTANT_DISMISS,
    ]);
    // The button value is exactly the ids we control — no free-form model text.
    expect(JSON.parse(actions.elements[0].value)).toEqual({
      kind: "complete",
      itemId: "i1",
      slackChannelId: "C_LEGAL",
    });
    // The item label is shown so the user knows what they're confirming.
    expect(JSON.stringify(blocks)).toContain("review the NDA");
  });

  it("uses reopen wording for an undo confirmation", () => {
    const blocks = mutationConfirmBlocks({ kind: "undo", ...base });
    const text = JSON.stringify(blocks);
    expect(text.toLowerCase()).toContain("reopen");
    const actions = blocks.find((b) => b.type === "actions") as { elements: Array<{ value: string }> };
    expect(JSON.parse(actions.elements[0].value).kind).toBe("undo");
  });
});
