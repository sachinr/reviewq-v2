import { parseBotCommand } from "../../src/slack/messageCommands";

const BOT = "UBOT123";

describe("parseBotCommand — channel (mention required)", () => {
  it("parses @bot add with a body", () => {
    expect(parseBotCommand(`<@${BOT}> add review this contract`, BOT, false)).toEqual({
      kind: "add",
      body: "review this contract",
    });
  });

  it("parses @bot add with no body (thread-reply add signal)", () => {
    expect(parseBotCommand(`<@${BOT}> add`, BOT, false)).toEqual({ kind: "add", body: "" });
  });

  it("parses @bot done / list / help", () => {
    expect(parseBotCommand(`<@${BOT}> done`, BOT, false)).toEqual({ kind: "done", body: "" });
    expect(parseBotCommand(`<@${BOT}> list`, BOT, false)).toEqual({ kind: "list" });
    expect(parseBotCommand(`<@${BOT}> help`, BOT, false)).toEqual({ kind: "help" });
  });

  it("is case-insensitive on the verb", () => {
    expect(parseBotCommand(`<@${BOT}> ADD stuff`, BOT, false)).toEqual({ kind: "add", body: "stuff" });
  });

  it("ignores a channel message that does not mention the bot", () => {
    expect(parseBotCommand("add this please", BOT, false)).toEqual({ kind: "ignore" });
  });

  it("ignores a mention we don't understand (no accidental help spam in channels)", () => {
    expect(parseBotCommand(`<@${BOT}> hello there`, BOT, false)).toEqual({ kind: "ignore" });
  });
});

describe("parseBotCommand — DM (no mention needed)", () => {
  it("parses a bare add / list", () => {
    expect(parseBotCommand("add buy milk", BOT, true)).toEqual({ kind: "add", body: "buy milk" });
    expect(parseBotCommand("list", BOT, true)).toEqual({ kind: "list" });
  });

  it("falls through to help for anything else in a DM", () => {
    expect(parseBotCommand("what can you do?", BOT, true)).toEqual({ kind: "help" });
  });

  it("does not treat bare 'done' as a command in a DM (mention-only, matches classic)", () => {
    // classic had no directDone; an unrecognized DM message becomes help.
    expect(parseBotCommand("done", BOT, true)).toEqual({ kind: "help" });
  });

  it("still honors an explicit mention inside a DM", () => {
    expect(parseBotCommand(`<@${BOT}> done`, BOT, true)).toEqual({ kind: "done", body: "" });
  });
});
