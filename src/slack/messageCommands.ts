// Pure parser for the classic text-command entry points — the third add path
// (alongside the message action and slash command) that the rebuild had dropped.
// The classic app matched these with regexes scattered across Event.ts; here the
// grammar is one pure, unit-tested function so the Bolt listener only has to do
// I/O (resolve rows, fetch the parent message, mutate) around a decided command.
//
// Grammar (case-insensitive), carried over verbatim from the classic app:
//   In a channel, addressed to the bot:  @bot add | done | list | help
//   In a DM (no mention needed):         add | list   (anything else → help)
// `done`/`help` are mention-only, matching the classic userCommands() table.

export type BotCommand =
  | { kind: "add"; body: string }
  | { kind: "done"; body: string }
  | { kind: "list" }
  | { kind: "help" }
  | { kind: "ignore" };

/**
 * Decide what a message means to the bot.
 *
 * @param rawText        the message text as Slack delivered it
 * @param botUserId      the workspace's bot user id (the `<@U…>` we answer to)
 * @param isDirectMessage true when the message arrived in a DM (channel id starts D)
 *
 * `body` is the message with the command word (and any leading bot mention)
 * stripped — the caller uses an empty body plus a thread reply as the signal to
 * add/complete the *parent* message instead of this one.
 */
export function parseBotCommand(
  rawText: string,
  botUserId: string,
  isDirectMessage: boolean,
): BotCommand {
  const text = (rawText ?? "").trim();
  const mentionPrefix = new RegExp(`^<@${escapeRegExp(botUserId)}>\\s*`, "i");
  const mentioned = mentionPrefix.test(text);
  const remainder = text.replace(mentionPrefix, "").trim();

  // A channel message only counts if it addressed the bot; a DM always counts.
  if (!mentioned && !isDirectMessage) return { kind: "ignore" };

  const verb = firstWord(remainder).toLowerCase();
  const body = remainder.slice(firstWord(remainder).length).trim();

  if (verb === "add") return { kind: "add", body };
  if (verb === "list") return { kind: "list" };

  // done/help only respond to an explicit mention, matching the classic table.
  if (mentioned && verb === "done") return { kind: "done", body };
  if (mentioned && verb === "help") return { kind: "help" };

  // In a DM, anything we didn't understand falls through to help (classic
  // "other" branch). A mention we didn't understand is left alone.
  if (isDirectMessage) return { kind: "help" };
  return { kind: "ignore" };
}

function firstWord(s: string): string {
  const m = s.match(/^\S+/);
  return m ? m[0] : "";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
