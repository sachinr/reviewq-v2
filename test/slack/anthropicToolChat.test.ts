import type { ContentBlock } from "@anthropic-ai/sdk/resources/messages";
import {
  toAnthropicMessage,
  toAnthropicTool,
  toAssistantTurn,
} from "../../src/slack/anthropicToolChat";
import { ASSISTANT_TOOLS } from "../../src/services/assistantTools";
import type { LoopMessage } from "../../src/services/toolLoop";

describe("anthropicToolChat translation", () => {
  it("maps a tool to the SDK shape without the loop-only `mutating` flag", () => {
    const complete = ASSISTANT_TOOLS.find((t) => t.name === "complete_item")!;
    const t = toAnthropicTool(complete);
    expect(t.name).toBe("complete_item");
    expect(t.description).toContain("confirmation");
    expect(t.input_schema.type).toBe("object");
    expect((t as unknown as Record<string, unknown>).mutating).toBeUndefined();
  });

  it("renders a plain user turn", () => {
    expect(toAnthropicMessage({ role: "user", text: "hi" })).toEqual({ role: "user", content: "hi" });
  });

  it("renders an assistant turn as text followed by tool_use blocks", () => {
    const m: LoopMessage = {
      role: "assistant",
      text: "Let me look.",
      toolUses: [{ id: "tu_1", name: "list_open_items", input: { channelId: "C1" } }],
    };
    expect(toAnthropicMessage(m)).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Let me look." },
        { type: "tool_use", id: "tu_1", name: "list_open_items", input: { channelId: "C1" } },
      ],
    });
  });

  it("omits empty assistant text but never emits an empty content array", () => {
    const onlyTool: LoopMessage = {
      role: "assistant",
      text: "   ",
      toolUses: [{ id: "tu_2", name: "complete_item", input: { itemId: "i1" } }],
    };
    const rendered = toAnthropicMessage(onlyTool);
    expect(rendered.content).toEqual([
      { type: "tool_use", id: "tu_2", name: "complete_item", input: { itemId: "i1" } },
    ]);

    // A degenerate empty assistant turn still yields non-empty content (API rule).
    const empty: LoopMessage = { role: "assistant", text: "", toolUses: [] };
    expect(Array.isArray(toAnthropicMessage(empty).content)).toBe(true);
    expect((toAnthropicMessage(empty).content as unknown[]).length).toBeGreaterThan(0);
  });

  it("renders tool_results as a user turn of tool_result blocks, echoing ids and error flags", () => {
    const m: LoopMessage = {
      role: "tool_results",
      results: [
        { toolUseId: "tu_1", content: '{"items":[]}', isError: false },
        { toolUseId: "tu_x", content: "refused: not a member", isError: true },
      ],
    };
    expect(toAnthropicMessage(m)).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_1", content: '{"items":[]}', is_error: false },
        { type: "tool_result", tool_use_id: "tu_x", content: "refused: not a member", is_error: true },
      ],
    });
  });

  it("collapses response content blocks into text + toolUses", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "One sec. " },
      { type: "tool_use", id: "tu_9", name: "list_open_items", input: { channelId: "C_LEGAL" } },
    ] as ContentBlock[];
    const turn = toAssistantTurn(content);
    expect(turn.text).toBe("One sec. ");
    expect(turn.toolUses).toEqual([{ id: "tu_9", name: "list_open_items", input: { channelId: "C_LEGAL" } }]);
  });

  it("defaults a missing tool_use input to an empty object", () => {
    const content = [{ type: "tool_use", id: "t", name: "list_open_items", input: null }] as unknown as ContentBlock[];
    expect(toAssistantTurn(content).toolUses[0].input).toEqual({});
  });
});
