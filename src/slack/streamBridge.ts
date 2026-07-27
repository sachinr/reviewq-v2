// streamBridge — forwards a stream of text chunks (LLM tokens, in Phase 2+) to
// Slack's streaming API in RATE-RESPECTING batches. The plan calls this out as a
// day-one Phase 1 concern: token-by-token forwarding would get rate-limited on
// busy workspaces, so batching + backoff must exist before any real LLM latency
// is wired in. Pure and I/O-free: it drives an injected StreamSink (the real one
// wraps chat.appendStream) and an injected sleep, so it is fully unit-testable
// — including the 429 path — with no Slack connection.

/** The append side of Slack's chat.startStream/appendStream/stopStream trio. */
export interface StreamSink {
  append(text: string): Promise<void>;
}

/** Marker carried by errors that represent a Slack rate-limit (HTTP 429). */
export interface RateLimited {
  retryAfterMs: number;
}

export function rateLimitError(retryAfterMs: number): Error & RateLimited {
  const err = new Error(`rate limited; retry after ${retryAfterMs}ms`) as Error & RateLimited;
  err.retryAfterMs = retryAfterMs;
  return err;
}

function isRateLimited(err: unknown): err is RateLimited {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as RateLimited).retryAfterMs === "number"
  );
}

export interface PumpOptions {
  /** Flush the buffer once it reaches this many characters. Default 280. */
  batchChars?: number;
  /** Injected sleep so tests don't wait on the wall clock. */
  sleep?: (ms: number) => Promise<void>;
  /** Max rate-limit retries for a single append before giving up. Default 5. */
  maxRetries?: number;
}

export interface PumpResult {
  appendCalls: number;
  totalChars: number;
  rateLimitRetries: number;
}

const DEFAULT_BATCH_CHARS = 280;
const DEFAULT_MAX_RETRIES = 5;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function pumpStream(
  tokens: AsyncIterable<string>,
  sink: StreamSink,
  opts: PumpOptions = {},
): Promise<PumpResult> {
  const batchChars = opts.batchChars ?? DEFAULT_BATCH_CHARS;
  const sleep = opts.sleep ?? defaultSleep;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;

  const result: PumpResult = { appendCalls: 0, totalChars: 0, rateLimitRetries: 0 };
  let buffer = "";

  const flush = async () => {
    if (buffer.length === 0) return;
    const text = buffer;
    buffer = "";
    await appendWithBackoff(sink, text, sleep, maxRetries, result);
    result.appendCalls += 1;
    result.totalChars += text.length;
  };

  for await (const token of tokens) {
    buffer += token;
    while (buffer.length >= batchChars) {
      const text = buffer.slice(0, batchChars);
      buffer = buffer.slice(batchChars);
      await appendWithBackoff(sink, text, sleep, maxRetries, result);
      result.appendCalls += 1;
      result.totalChars += text.length;
    }
  }
  await flush();

  return result;
}

async function appendWithBackoff(
  sink: StreamSink,
  text: string,
  sleep: (ms: number) => Promise<void>,
  maxRetries: number,
  result: PumpResult,
): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      await sink.append(text);
      return;
    } catch (err) {
      if (isRateLimited(err) && attempt < maxRetries) {
        attempt += 1;
        result.rateLimitRetries += 1;
        await sleep(err.retryAfterMs);
        continue;
      }
      throw err;
    }
  }
}
