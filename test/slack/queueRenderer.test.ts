import {
  PAGE_SIZE,
  renderQueue,
  ACTION_COMPLETE_ITEM,
  ACTION_UNDO_ITEM,
  ACTION_QUEUE_PAGE,
} from "../../src/slack/queueRenderer";
import { makeItem } from "../fakes";

function sections(blocks: any[]) {
  return blocks.filter((b) => b.type === "section");
}
function itemSections(blocks: any[]) {
  return sections(blocks).filter((s) => s.accessory);
}
function actionsBlocks(blocks: any[]) {
  return blocks.filter((b) => b.type === "actions");
}

describe("renderQueue", () => {
  it("renders an empty-state message when there are no items", () => {
    const { blocks, totalPages } = renderQueue({ items: [], channelName: "legal" });
    expect(totalPages).toBe(1);
    const text = JSON.stringify(blocks);
    expect(text.toLowerCase()).toContain("no items");
    // no per-item action buttons on an empty queue
    expect(JSON.stringify(blocks)).not.toContain(ACTION_COMPLETE_ITEM);
  });

  it("renders an open item as a section linking the message with a Mark as Done button", () => {
    const item = makeItem({
      id: "it_open",
      status: "open",
      messageText: "review the Q3 contract",
      permalink: "https://slack.example/p1",
    });
    const { blocks } = renderQueue({ items: [item] });

    const sec = itemSections(blocks)[0];
    expect(sec.text.text).toContain("review the Q3 contract");
    expect(sec.text.text).toContain("https://slack.example/p1");
    expect(sec.accessory.action_id).toBe(ACTION_COMPLETE_ITEM);
    expect(sec.accessory.value).toBe("it_open");
  });

  it("renders a recently-closed item with an Undo button instead of Done", () => {
    const item = makeItem({ id: "it_done", status: "complete", completedAt: new Date() });
    const { blocks } = renderQueue({ items: [item] });

    const sec = itemSections(blocks)[0];
    expect(sec.accessory.action_id).toBe(ACTION_UNDO_ITEM);
    expect(sec.accessory.value).toBe("it_done");
  });

  it("paginates by PAGE_SIZE and reports totalPages", () => {
    const items = Array.from({ length: 2 * PAGE_SIZE + 1 }, (_, i) =>
      makeItem({ id: `it_${String(i).padStart(2, "0")}`, status: "open" }),
    );

    const p1 = renderQueue({ items, page: 1 });
    expect(p1.totalPages).toBe(3);
    expect(p1.page).toBe(1);
    expect(sections(p1.blocks).filter((s) => s.accessory)).toHaveLength(PAGE_SIZE);

    const p2 = renderQueue({ items, page: 2 });
    const p2FirstItemValue = sections(p2.blocks).find((s) => s.accessory)!.accessory.value;
    expect(p2FirstItemValue).toBe(`it_${String(PAGE_SIZE).padStart(2, "0")}`);

    const p3 = renderQueue({ items, page: 3 });
    expect(sections(p3.blocks).filter((s) => s.accessory)).toHaveLength(1);
  });

  it("clamps an out-of-range page into bounds", () => {
    const items = Array.from({ length: 3 }, (_, i) => makeItem({ id: `it_${i}`, status: "open" }));
    const { page, totalPages } = renderQueue({ items, page: 99 });
    expect(totalPages).toBe(1);
    expect(page).toBe(1);
  });

  it("shows a Next control (carrying the target page) when more pages exist, and no Prev on page 1", () => {
    const items = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => makeItem({ id: `it_${i}`, status: "open" }));
    const { blocks } = renderQueue({ items, page: 1 });

    const controls = actionsBlocks(blocks);
    expect(controls).toHaveLength(1);
    const pageButtons = controls[0].elements.filter((e: any) => e.action_id === ACTION_QUEUE_PAGE);
    const values = pageButtons.map((b: any) => JSON.parse(b.value));
    // a Next to page 2 exists; no Prev (page 0) on the first page
    expect(values.some((v: any) => v.page === 2)).toBe(true);
    expect(values.some((v: any) => v.page === 0)).toBe(false);
  });
});
