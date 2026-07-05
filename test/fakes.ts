// In-memory fakes for the itemService ports. These let the service's business
// logic be exercised deterministically with no DB / Redis / Slack connection.
// The Prisma-backed and WebClient-backed real adapters have their own
// integration tests (gated on DATABASE_URL / run in CI).

import type { Item, ItemStatus } from "@prisma/client";
import type {
  CreateItemData,
  ItemRepository,
  SlackGateway,
} from "../src/services/ports";

let seq = 0;
export function resetSeq(): void {
  seq = 0;
}
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq}`;
}

const FIXED_NOW = new Date("2026-07-05T12:00:00.000Z");

/** Build a fully-formed Item row with sensible defaults, overridable per test. */
export function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: nextId("item"),
    workspaceId: "ws_1",
    channelId: "chan_1",
    slackMessageTs: "1700000000.000100",
    slackThreadTs: null,
    messageText: "review this",
    permalink: null,
    filesJson: null,
    sourceMetadataKey: null,
    authorSlackId: "U_AUTHOR",
    authorUserId: "user_author",
    flaggedByUserId: "user_flagger",
    completedByUserId: null,
    status: "open" as ItemStatus,
    completedAt: null,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

export class FakeItemRepository implements ItemRepository {
  public items = new Map<string, Item>();

  seed(...items: Item[]): void {
    for (const it of items) this.items.set(it.id, it);
  }

  async findByChannelAndTs(channelId: string, slackMessageTs: string): Promise<Item | null> {
    for (const it of this.items.values()) {
      if (it.channelId === channelId && it.slackMessageTs === slackMessageTs) return it;
    }
    return null;
  }

  async findById(id: string): Promise<Item | null> {
    return this.items.get(id) ?? null;
  }

  async create(data: CreateItemData): Promise<Item> {
    const item = makeItem({
      id: nextId("item"),
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
      status: "open" as ItemStatus,
      completedByUserId: null,
      completedAt: null,
    });
    this.items.set(item.id, item);
    return item;
  }

  async markComplete(id: string, completedByUserId: string, completedAt: Date): Promise<Item> {
    const it = this.items.get(id);
    if (!it) throw new Error(`item ${id} not found`);
    const updated: Item = { ...it, status: "complete" as ItemStatus, completedByUserId, completedAt };
    this.items.set(id, updated);
    return updated;
  }

  async markOpen(id: string): Promise<Item> {
    const it = this.items.get(id);
    if (!it) throw new Error(`item ${id} not found`);
    const updated: Item = { ...it, status: "open" as ItemStatus, completedByUserId: null, completedAt: null };
    this.items.set(id, updated);
    return updated;
  }

  async findOpenByChannel(channelId: string): Promise<Item[]> {
    return [...this.items.values()]
      .filter((it) => it.channelId === channelId && it.status === "open")
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async findRecentlyClosedByChannel(channelId: string, since: Date): Promise<Item[]> {
    return [...this.items.values()]
      .filter(
        (it) =>
          it.channelId === channelId &&
          it.status === "complete" &&
          it.completedAt != null &&
          it.completedAt >= since,
      )
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}

export interface RecordedCall {
  method: string;
  args: unknown[];
}

export class FakeSlackGateway implements SlackGateway {
  public calls: RecordedCall[] = [];
  public permalinkToReturn: string | null = "https://slack.example/archives/C1/p1700000000000100";

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }
  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  async getPermalink(channelSlackId: string, messageTs: string): Promise<string | null> {
    this.record("getPermalink", channelSlackId, messageTs);
    return this.permalinkToReturn;
  }
  async postMessage(channel: string, text: string, blocks?: unknown[]): Promise<void> {
    this.record("postMessage", channel, text, blocks);
  }
  async addReaction(channelSlackId: string, messageTs: string, name: string): Promise<void> {
    this.record("addReaction", channelSlackId, messageTs, name);
  }
  async removeReaction(channelSlackId: string, messageTs: string, name: string): Promise<void> {
    this.record("removeReaction", channelSlackId, messageTs, name);
  }
}
