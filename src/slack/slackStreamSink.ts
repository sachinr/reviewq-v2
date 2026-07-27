// slackStreamSink — the live Slack sink for streaming assistant replies. This is
// the adapter the plan flagged as the one genuinely new piece of "live
// streaming": it wraps Slack's chat.startStream / chat.appendStream /
// chat.stopStream trio behind streamBridge's StreamSink port, so the tested
// streamBridge (batching + 429 backoff) can pump LLM token deltas into a real
// Slack message that renders incrementally.
//
// Lifecycle is lazy: the stream is opened on the FIRST append (startStream
// requires initial text and returns the message `ts`), subsequent appends reuse
// that ts, and stop() finalizes the message. If nothing is ever appended (the
// model produced no output), stop() is a no-op — there is no half-open message
// to clean up.
//
// Kept trivially fakeable: it depends only on a narrow StreamingChatClient
// interface (the three methods it calls), not the whole WebClient, so its
// start/append/stop sequencing is unit-tested with no Slack connection. Slack's
// rate-limit errors are translated into streamBridge's RateLimited shape so the
// existing backoff path drives retries.

import { rateLimitError, type StreamSink } from "./streamBridge";

/** Arguments for chat.startStream (narrowed to what this sink sends). */
interface StartStreamArgs {
  channel: string;
  thread_ts?: string;
  markdown_text?: string;
  recipient_team_id?: string;
  recipient_user_id?: string;
}

interface AppendStreamArgs {
  channel: string;
  ts: string;
  markdown_text?: string;
}

interface StopStreamArgs {
  channel: string;
  ts: string;
}

/**
 * The slice of a Slack WebClient this sink drives. Declaring only the three
 * streaming methods (rather than importing WebClient) keeps the sink unit-
 * testable against a hand-rolled fake; the real WebClient satisfies it
 * structurally.
 */
export interface StreamingChatClient {
  chat: {
    startStream(args: StartStreamArgs): Promise<{ ts?: string }>;
    appendStream(args: AppendStreamArgs): Promise<unknown>;
    stopStream(args: StopStreamArgs): Promise<unknown>;
  };
}

/** Where a streamed reply is posted. */
export interface SlackStreamTarget {
  /** The channel/DM to stream into (the assistant thread's IM channel). */
  channel: string;
  /** The thread to stream the reply into. */
  threadTs?: string;
  /**
   * Required by Slack only when streaming *outside* a DM (e.g. a channel-scoped
   * reply); harmless to omit for the assistant DM case.
   */
  recipientTeamId?: string;
  recipientUserId?: string;
}

/** A StreamSink backed by a live Slack stream, plus its finalize/inspection API. */
export interface SlackStreamSink extends StreamSink {
  /** Finalize the streamed message. Safe to call when never started, and idempotent. */
  stop(): Promise<void>;
  /** The message ts, available once the stream has started. */
  readonly ts: string | undefined;
  /** Whether the stream has been opened (i.e. at least one append happened). */
  readonly started: boolean;
}

export function createSlackStreamSink(
  client: StreamingChatClient,
  target: SlackStreamTarget,
): SlackStreamSink {
  let ts: string | undefined;
  let stopped = false;

  async function append(text: string): Promise<void> {
    if (ts === undefined) {
      const res = await withRateLimitTranslation(() =>
        client.chat.startStream({
          channel: target.channel,
          thread_ts: target.threadTs,
          markdown_text: text,
          ...(target.recipientTeamId ? { recipient_team_id: target.recipientTeamId } : {}),
          ...(target.recipientUserId ? { recipient_user_id: target.recipientUserId } : {}),
        }),
      );
      if (!res.ts) {
        throw new Error("chat.startStream returned no message ts; cannot continue streaming");
      }
      ts = res.ts;
      return;
    }
    await withRateLimitTranslation(() =>
      client.chat.appendStream({ channel: target.channel, ts: ts as string, markdown_text: text }),
    );
  }

  async function stop(): Promise<void> {
    if (ts === undefined || stopped) return; // nothing opened, or already finalized
    stopped = true;
    await client.chat.stopStream({ channel: target.channel, ts });
  }

  return {
    append,
    stop,
    get ts() {
      return ts;
    },
    get started() {
      return ts !== undefined;
    },
  };
}

/**
 * Slack's WebClient throws a rate-limited error carrying `retryAfter` in seconds
 * (code `slack_webapi_rate_limited_error`). streamBridge only knows how to back
 * off on its own RateLimited shape (`retryAfterMs`), so translate at the boundary
 * — that keeps the 429 handling in one place (streamBridge) instead of
 * duplicating a backoff loop here.
 */
async function withRateLimitTranslation<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const retryAfterSec = slackRetryAfterSeconds(err);
    if (retryAfterSec !== undefined) {
      throw rateLimitError(Math.round(retryAfterSec * 1000));
    }
    throw err;
  }
}

function slackRetryAfterSeconds(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { code?: string; retryAfter?: number };
  if (e.code === "slack_webapi_rate_limited_error" && typeof e.retryAfter === "number") {
    return e.retryAfter;
  }
  return undefined;
}
