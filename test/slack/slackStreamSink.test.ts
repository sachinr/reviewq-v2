import {
  createSlackStreamSink,
  type StreamingChatClient,
} from "../../src/slack/slackStreamSink";
import { pumpStream } from "../../src/slack/streamBridge";

interface Call {
  method: "startStream" | "appendStream" | "stopStream";
  args: Record<string, unknown>;
}

/**
 * A fake of the three chat.*Stream methods, recording every call and handing
 * back a fixed `ts` from startStream. Individual calls can be scripted to throw
 * (e.g. a Slack rate-limit error) to exercise the sink's error translation.
 */
function fakeChat(ts = "1700000000.000200") {
  const calls: Call[] = [];
  const throwOn = new Map<string, unknown>();
  const failStartCount = { n: 0 };
  const client: StreamingChatClient = {
    chat: {
      async startStream(args) {
        calls.push({ method: "startStream", args: args as never });
        const err = throwOn.get(`startStream:${failStartCount.n++}`);
        if (err) throw err;
        return { ts };
      },
      async appendStream(args) {
        calls.push({ method: "appendStream", args: args as never });
        const err = throwOn.get(`appendStream:${calls.filter((c) => c.method === "appendStream").length - 1}`);
        if (err) throw err;
        return {};
      },
      async stopStream(args) {
        calls.push({ method: "stopStream", args: args as never });
        return {};
      },
    },
  };
  return {
    client,
    calls,
    failStart: (index: number, err: unknown) => throwOn.set(`startStream:${index}`, err),
    failAppend: (index: number, err: unknown) => throwOn.set(`appendStream:${index}`, err),
  };
}

/** The shape @slack/web-api throws on HTTP 429. */
function slackRateLimited(retryAfterSec: number): Error {
  const err = new Error(`rate limited; retry after ${retryAfterSec}s`) as Error & {
    code: string;
    retryAfter: number;
  };
  err.code = "slack_webapi_rate_limited_error";
  err.retryAfter = retryAfterSec;
  return err;
}

describe("createSlackStreamSink", () => {
  it("starts the stream on the first append and appends thereafter, threading channel + ts", async () => {
    const { client, calls } = fakeChat("1700000000.000200");
    const sink = createSlackStreamSink(client, { channel: "D123", threadTs: "1700.100" });

    await sink.append("Hello, ");
    await sink.append("world");
    await sink.stop();

    expect(calls.map((c) => c.method)).toEqual(["startStream", "appendStream", "stopStream"]);
    // startStream carries the initial text + thread, and reports the message ts.
    expect(calls[0].args).toMatchObject({
      channel: "D123",
      thread_ts: "1700.100",
      markdown_text: "Hello, ",
    });
    expect(sink.ts).toBe("1700000000.000200");
    // appendStream + stopStream reuse the ts returned by startStream.
    expect(calls[1].args).toMatchObject({ channel: "D123", ts: "1700000000.000200", markdown_text: "world" });
    expect(calls[2].args).toMatchObject({ channel: "D123", ts: "1700000000.000200" });
  });

  it("is a no-op stop when nothing was ever appended (empty model output)", async () => {
    const { client, calls } = fakeChat();
    const sink = createSlackStreamSink(client, { channel: "D123", threadTs: "1700.100" });

    await sink.stop();

    expect(calls).toHaveLength(0);
    expect(sink.started).toBe(false);
    expect(sink.ts).toBeUndefined();
  });

  it("passes optional recipient fields through to startStream when the target sets them", async () => {
    const { client, calls } = fakeChat();
    const sink = createSlackStreamSink(client, {
      channel: "C_PUBLIC",
      threadTs: "1700.100",
      recipientTeamId: "T1",
      recipientUserId: "U1",
    });

    await sink.append("hi");

    expect(calls[0].args).toMatchObject({ recipient_team_id: "T1", recipient_user_id: "U1" });
  });

  it("translates a Slack rate-limit error into streamBridge's RateLimited shape so appends back off", async () => {
    const { client, failStart } = fakeChat();
    failStart(0, slackRateLimited(3));
    const sink = createSlackStreamSink(client, { channel: "D123", threadTs: "1700.100" });

    await expect(sink.append("x")).rejects.toMatchObject({ retryAfterMs: 3000 });
  });

  it("cooperates with pumpStream: a 429 on the first append is retried, losing no text", async () => {
    const { client, calls } = fakeChat();
    // The first flush hits startStream, which 429s once, then succeeds on retry.
    let failed = false;
    const raw = client.chat.startStream;
    client.chat.startStream = async (args) => {
      if (!failed) {
        failed = true;
        throw slackRateLimited(2);
      }
      return raw(args);
    };
    const sink = createSlackStreamSink(client, { channel: "D123", threadTs: "1700.100" });

    async function* tokens() {
      yield "hello ";
      yield "world";
    }
    const slept: number[] = [];
    const result = await pumpStream(tokens(), sink, {
      batchChars: 100,
      sleep: async (ms) => void slept.push(ms),
    });
    await sink.stop();

    expect(slept).toContain(2000); // backed off for the server-specified delay
    expect(result.rateLimitRetries).toBe(1);
    const appended = calls
      .filter((c) => c.method !== "stopStream")
      .map((c) => c.args.markdown_text)
      .join("");
    expect(appended).toBe("hello world"); // nothing dropped
  });

  it("stop() finalizes only once even if called twice", async () => {
    const { client, calls } = fakeChat();
    const sink = createSlackStreamSink(client, { channel: "D123", threadTs: "1700.100" });

    await sink.append("hi");
    await sink.stop();
    await sink.stop();

    expect(calls.filter((c) => c.method === "stopStream")).toHaveLength(1);
  });
});
