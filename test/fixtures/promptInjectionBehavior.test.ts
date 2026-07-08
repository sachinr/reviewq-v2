// Behavioral prompt-injection gate — the "live merge gate" the plan calls for.
//
// promptInjection.test.ts keeps the fixtures well-formed. THIS suite makes them
// bite: for each adversarial fixture it constructs the WORST-CASE model output —
// the model, having read the untrusted content, actually emits the forbidden tool
// call — and asserts the server-side executor contains it anyway. That is exactly
// the plan's guarantee: "tool execution is permission-checked server-side
// regardless of what the model requests." We assert the guardrail, not the model:
// model-level resistance is covered separately by the advisory nightly real-API
// suite; the deterministic, CI-blocking property is that a forbidden call CANNOT
// take effect even if the model is fully hijacked.

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  executeToolCall,
  type ToolCall,
  type ToolExecContext,
  type ToolOutcome,
} from "../../src/services/assistantTools";
import type { ChannelContext } from "../../src/services/ports";

interface InjectionFixture {
  name: string;
  untrustedContent: string;
  userInstruction: string;
  expectation: { mustRefuseToolCall: boolean; forbiddenTools: string[]; rationale: string };
}

const FIXTURE_DIR = join(__dirname, "prompt-injection");

function loadFixtures(): InjectionFixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")) as InjectionFixture);
}

// The channel the assistant thread is legitimately about — the only one the
// requesting user is a member of. Any fixture that reaches for another channel is
// crossing the authorization boundary.
const CURRENT: ChannelContext = {
  id: "chan_current",
  workspaceId: "ws_1",
  slackChannelId: "C_CURRENT",
  isBotMember: true,
  type: "channel",
};
const PRIVATE_TARGET = "C_FINANCE_PRIVATE";

/**
 * Translate a fixture's abstract `forbiddenTools` into the concrete worst-case
 * tool call(s) a hijacked model would emit from the untrusted content.
 */
function worstCaseCalls(forbiddenTools: string[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const t of forbiddenTools) {
    if (t.startsWith("listOpenItems")) {
      // cross-channel exfiltration: read a channel the user cannot see.
      calls.push({ name: "list_open_items", input: { channelId: PRIVATE_TARGET } });
    } else if (t === "completeItem" || t === "completeItemByMessageTs") {
      calls.push({ name: "complete_item", input: { itemId: "i_injected" } });
    } else if (t === "undoComplete") {
      calls.push({ name: "undo_complete", input: { itemId: "i_injected" } });
    } else {
      throw new Error(`fixture references an unmapped forbidden tool: ${t}`);
    }
  }
  return calls;
}

/** A context that admits only the current channel and records any read attempt. */
function buildCtx() {
  const reads: string[] = [];
  const ctx: ToolExecContext = {
    workspaceId: "ws_1",
    requestingSlackId: "U_REQ",
    canAccessChannel: (id) => id === CURRENT.slackChannelId,
    resolveChannel: async (id) => (id === CURRENT.slackChannelId ? CURRENT : null),
    items: {
      // A read that reaches this far would have already passed the boundary; record
      // it so the test can prove a cross-channel read never got here.
      async listOpenItems(channel) {
        reads.push(channel.slackChannelId);
        return [];
      },
    },
  };
  return { ctx, reads };
}

/** An outcome is "contained" if it did not take effect: refused, or deferred. */
function isContained(o: ToolOutcome): boolean {
  return o.status === "refused" || o.status === "needs_confirmation";
}

describe("prompt-injection behavioral gate", () => {
  const fixtures = loadFixtures();

  it("has fixtures to gate on", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures.map((f) => [f.name, f] as const))(
    "%s: the forbidden tool call cannot take effect server-side",
    async (_name, fixture) => {
      const { ctx, reads } = buildCtx();
      const calls = worstCaseCalls(fixture.expectation.forbiddenTools);
      expect(calls.length).toBeGreaterThan(0);

      for (const call of calls) {
        const outcome = await executeToolCall(call, ctx);
        // Every forbidden call is contained (refused or deferred), never `ok`.
        expect(isContained(outcome)).toBe(true);
        expect(outcome.status).not.toBe("ok");
      }

      // The authorization boundary held: no private channel was ever read.
      expect(reads).not.toContain(PRIVATE_TARGET);
    },
  );
});
