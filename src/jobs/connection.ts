// One place that turns a REDIS_URL into an ioredis connection configured the way
// BullMQ needs it. BullMQ requires `maxRetriesPerRequest: null` on the client a
// Worker blocks on (otherwise ioredis aborts the blocking BRPOPLPUSH that the
// worker waits on); setting it here keeps that requirement out of every call
// site. The producer (Queue) and consumer (Worker) each get their own client so
// neither starves the other's command pipeline.

import IORedis, { type Redis } from "ioredis";
import type { ConnectionOptions } from "bullmq";

export function createRedisConnection(redisUrl: string): Redis {
  return new IORedis(redisUrl, { maxRetriesPerRequest: null });
}

/**
 * BullMQ bundles its own copy of ioredis, so a `Redis` from our top-level ioredis
 * is structurally — but only nominally — incompatible with BullMQ's
 * `ConnectionOptions` (a `protected` field identity mismatch across the two
 * copies). Both are ioredis 5.x and interoperate fine at runtime, so we bridge
 * the type at this single boundary rather than sprinkling casts at every
 * `new Queue`/`new Worker`.
 */
export function bullConnection(connection: Redis): ConnectionOptions {
  return connection as unknown as ConnectionOptions;
}
