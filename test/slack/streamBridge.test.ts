import { pumpStream, rateLimitError, type StreamSink } from "../../src/slack/streamBridge";

async function* tokens(...chunks: string[]): AsyncGenerator<string> {
  for (const c of chunks) yield c;
}

/** A sink that records appended text and can be scripted to throw on given call indexes. */
class RecordingSink implements StreamSink {
  public appended: string[] = [];
  private throwOn = new Map<number, Error>();
  private call = 0;

  failCall(index: number, err: Error): this {
    this.throwOn.set(index, err);
    return this;
  }
  async append(text: string): Promise<void> {
    const err = this.throwOn.get(this.call);
    this.call += 1;
    if (err) throw err;
    this.appended.push(text);
  }
  get fullText(): string {
    return this.appended.join("");
  }
}

function recordingSleep() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms) };
}

describe("pumpStream", () => {
  it("batches many small tokens into far fewer append calls, preserving order and full text", async () => {
    const sink = new RecordingSink();
    const { sleep } = recordingSleep();

    const result = await pumpStream(tokens(..."abcdefghijklmnopqrstuvwxy".split("")), sink, {
      batchChars: 10,
      sleep,
    });

    // 25 single-char tokens, flush every 10 chars => 3 appends (10 + 10 + 5)
    expect(sink.appended).toEqual(["abcdefghij", "klmnopqrst", "uvwxy"]);
    expect(sink.fullText).toBe("abcdefghijklmnopqrstuvwxy");
    expect(result.appendCalls).toBe(3);
    expect(result.totalChars).toBe(25);
  });

  it("flushes the trailing remainder even when it is smaller than a batch", async () => {
    const sink = new RecordingSink();
    const { sleep } = recordingSleep();

    await pumpStream(tokens("hello ", "world"), sink, { batchChars: 100, sleep });

    expect(sink.fullText).toBe("hello world");
    expect(sink.appended).toHaveLength(1);
  });

  it("backs off and retries on a rate-limit error, losing no text", async () => {
    const sink = new RecordingSink().failCall(0, rateLimitError(2000));
    const { slept, sleep } = recordingSleep();

    const result = await pumpStream(tokens("hello ", "world"), sink, { batchChars: 100, sleep });

    // first append 429'd, retried after the server-specified delay, then succeeded
    expect(slept).toContain(2000);
    expect(sink.fullText).toBe("hello world");
    expect(result.rateLimitRetries).toBe(1);
  });

  it("gives up after maxRetries and surfaces the error rather than silently dropping output", async () => {
    const sink = new RecordingSink()
      .failCall(0, rateLimitError(1000))
      .failCall(1, rateLimitError(1000))
      .failCall(2, rateLimitError(1000));
    const { sleep } = recordingSleep();

    await expect(
      pumpStream(tokens("data"), sink, { batchChars: 1, sleep, maxRetries: 2 }),
    ).rejects.toThrow();
  });

  it("rethrows a non-rate-limit error immediately without retrying", async () => {
    const sink = new RecordingSink().failCall(0, new Error("boom"));
    const { slept, sleep } = recordingSleep();

    await expect(pumpStream(tokens("x"), sink, { batchChars: 1, sleep })).rejects.toThrow("boom");
    expect(slept).toHaveLength(0);
  });
});
