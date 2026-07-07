import { createItemService } from "../../src/services/itemService";
import { UNDO_WINDOW_MS, type ChannelContext, type SourceMessage } from "../../src/services/ports";
import { FakeItemRepository, FakeSlackGateway, makeItem } from "../fakes";

const NOW = new Date("2026-07-05T12:00:00.000Z");

const channel: ChannelContext = {
  id: "chan_1",
  workspaceId: "ws_1",
  slackChannelId: "C_LEGAL",
  isBotMember: true,
  type: "channel",
};

const source: SourceMessage = {
  slackMessageTs: "1700000000.000100",
  slackThreadTs: null,
  messageText: "please review the Q3 contract",
  authorSlackId: "U_AUTHOR",
  authorUserId: "user_author",
  filesJson: null,
};

function build() {
  const repo = new FakeItemRepository();
  const slack = new FakeSlackGateway();
  const service = createItemService({ repo, slack });
  return { repo, slack, service };
}

describe("itemService.createItem", () => {
  it("persists a new open item and stamps the permalink", async () => {
    const { repo, slack, service } = build();

    const result = await service.createItem(channel, source, "user_flagger");

    expect(result.wasDuplicate).toBe(false);
    expect(result.wasReopened).toBe(false);
    expect(result.item.status).toBe("open");
    expect(result.item.permalink).toBe(slack.permalinkToReturn);
    expect(result.item.authorSlackId).toBe("U_AUTHOR");
    expect(result.item.flaggedByUserId).toBe("user_flagger");
    // one item now lives in the repo
    expect(await repo.findByChannelAndTs("chan_1", source.slackMessageTs)).not.toBeNull();
    // permalink was fetched from Slack
    expect(slack.callsTo("getPermalink")).toHaveLength(1);
  });

  it("is idempotent: re-adding an already-open message returns the existing item, no duplicate", async () => {
    const { repo, service } = build();
    repo.seed(
      makeItem({ id: "existing", channelId: "chan_1", slackMessageTs: source.slackMessageTs, status: "open" }),
    );

    const result = await service.createItem(channel, source, "user_flagger");

    expect(result.wasDuplicate).toBe(true);
    expect(result.item.id).toBe("existing");
    expect(repo.items.size).toBe(1);
  });

  it("reopens a previously-completed item when its message is added again", async () => {
    const { repo, service } = build();
    repo.seed(
      makeItem({
        id: "done",
        channelId: "chan_1",
        slackMessageTs: source.slackMessageTs,
        status: "complete",
        completedByUserId: "user_x",
        completedAt: NOW,
      }),
    );

    const result = await service.createItem(channel, source, "user_flagger");

    expect(result.wasReopened).toBe(true);
    expect(result.item.id).toBe("done");
    expect(result.item.status).toBe("open");
    expect(result.item.completedAt).toBeNull();
  });

  it("stores a bot-authored message with a null authorUserId but keeps the raw author slack id", async () => {
    const { service } = build();
    const botSource: SourceMessage = { ...source, authorSlackId: "B_GITHUB", authorUserId: null };

    const result = await service.createItem(channel, botSource, "user_flagger");

    expect(result.item.authorUserId).toBeNull();
    expect(result.item.authorSlackId).toBe("B_GITHUB");
  });
});

describe("itemService.completeItem", () => {
  it("marks complete, adds the ✅ reaction, and DMs the original author", async () => {
    const { repo, slack, service } = build();
    repo.seed(makeItem({ id: "it1", channelId: "chan_1", authorSlackId: "U_AUTHOR", status: "open" }));

    const result = await service.completeItem("it1", channel, { userId: "user_completer", slackId: "U_COMPLETER" }, NOW);

    expect(result.item.status).toBe("complete");
    expect(result.item.completedByUserId).toBe("user_completer");
    expect(result.item.completedAt).toEqual(NOW);
    // reaction added to the source message in the channel
    const reactions = slack.callsTo("addReaction");
    expect(reactions).toHaveLength(1);
    expect(reactions[0].args).toEqual(["C_LEGAL", "1700000000.000100", "white_check_mark"]);
    // author notified by DM (posted to their slack id)
    expect(result.notifiedAuthor).toBe(true);
    const dms = slack.callsTo("postMessage");
    expect(dms).toHaveLength(1);
    expect(dms[0].args[0]).toBe("U_AUTHOR");
  });

  it("does not DM the author when the completer IS the author", async () => {
    const { repo, slack, service } = build();
    repo.seed(makeItem({ id: "it1", channelId: "chan_1", authorSlackId: "U_SAME", status: "open" }));

    const result = await service.completeItem("it1", channel, { userId: "user_same", slackId: "U_SAME" }, NOW);

    expect(result.notifiedAuthor).toBe(false);
    expect(slack.callsTo("postMessage")).toHaveLength(0);
  });

  it("skips the reaction when the bot is not a member of the channel", async () => {
    const { repo, slack, service } = build();
    repo.seed(makeItem({ id: "it1", channelId: "chan_1", status: "open" }));

    await service.completeItem("it1", { ...channel, isBotMember: false }, { userId: "u", slackId: "U_C" }, NOW);

    expect(slack.callsTo("addReaction")).toHaveLength(0);
  });

  it("refuses to complete an item that belongs to a different channel (authorization boundary)", async () => {
    const { repo, slack, service } = build();
    // Item lives in another channel of the same workspace; the payload's channel
    // must not be able to mutate it.
    repo.seed(makeItem({ id: "it1", channelId: "chan_OTHER", status: "open" }));

    await expect(
      service.completeItem("it1", channel, { userId: "u", slackId: "U_C" }, NOW),
    ).rejects.toThrow(/does not belong/i);
    // No mutation, no Slack side effects leaked.
    expect((await repo.findById("it1"))?.status).toBe("open");
    expect(slack.calls).toHaveLength(0);
  });

  it("refuses to complete an item from a different workspace", async () => {
    const { repo, service } = build();
    repo.seed(makeItem({ id: "it1", channelId: "chan_1", workspaceId: "ws_OTHER", status: "open" }));

    await expect(
      service.completeItem("it1", channel, { userId: "u", slackId: "U_C" }, NOW),
    ).rejects.toThrow(/does not belong/i);
  });
});

describe("itemService.undoComplete", () => {
  it("reopens and removes the reaction when inside the undo window", async () => {
    const { repo, slack, service } = build();
    const completedAt = new Date(NOW.getTime() - (UNDO_WINDOW_MS - 1000)); // 59s ago
    repo.seed(makeItem({ id: "it1", channelId: "chan_1", status: "complete", completedByUserId: "u", completedAt }));

    const result = await service.undoComplete("it1", channel, NOW);

    expect(result.withinWindow).toBe(true);
    expect(result.item.status).toBe("open");
    expect(result.item.completedAt).toBeNull();
    expect(slack.callsTo("removeReaction")).toHaveLength(1);
  });

  it("refuses to undo (no mutation) once the window has elapsed", async () => {
    const { repo, slack, service } = build();
    const completedAt = new Date(NOW.getTime() - (UNDO_WINDOW_MS + 1000)); // 61s ago
    repo.seed(makeItem({ id: "it1", channelId: "chan_1", status: "complete", completedByUserId: "u", completedAt }));

    const result = await service.undoComplete("it1", channel, NOW);

    expect(result.withinWindow).toBe(false);
    expect(result.item.status).toBe("complete");
    expect(slack.callsTo("removeReaction")).toHaveLength(0);
  });

  it("refuses to undo an item that belongs to a different channel (authorization boundary)", async () => {
    const { repo, service } = build();
    const completedAt = new Date(NOW.getTime() - 1000);
    repo.seed(makeItem({ id: "it1", channelId: "chan_OTHER", status: "complete", completedByUserId: "u", completedAt }));

    await expect(service.undoComplete("it1", channel, NOW)).rejects.toThrow(/does not belong/i);
    expect((await repo.findById("it1"))?.status).toBe("complete");
  });
});

describe("itemService.openAndRecentlyClosedItems", () => {
  it("returns open items plus items closed within the undo window, sorted by creation", async () => {
    const { repo, service } = build();
    const recentClose = new Date(NOW.getTime() - 30_000);
    const staleClose = new Date(NOW.getTime() - 5 * 60_000);
    repo.seed(
      makeItem({ id: "item_a", channelId: "chan_1", status: "open" }),
      makeItem({ id: "item_b", channelId: "chan_1", status: "complete", completedAt: recentClose }),
      makeItem({ id: "item_c", channelId: "chan_1", status: "complete", completedAt: staleClose }),
    );

    const view = await service.openAndRecentlyClosedItems(channel, NOW);

    expect(view.open.map((i) => i.id)).toEqual(["item_a"]);
    expect(view.recentlyClosed.map((i) => i.id)).toEqual(["item_b"]);
    expect(view.all.map((i) => i.id)).toEqual(["item_a", "item_b"]);
  });
});
