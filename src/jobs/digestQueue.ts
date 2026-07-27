// digest-jobs — the background transport for the scheduled staleness digest.
// A BullMQ repeatable "sweep" enumerates channels with open items and enqueues one
// channel-digest job each; the worker runs this handler, which asks the model for
// a digest of the channel's stale items and posts it. This module is the pure core
// (queue name, payload, collaborator ports, handler); it imports neither BullMQ nor
// Redis nor the SDK, so `runChannelDigestJob` is unit-tested against fakes. The
// BullMQ Queue/Worker + the Prisma/Anthropic/Slack adapters live next to it.

import { computeStaleDigest, type DigestModel, type StaleItem } from "../services/digest";

/** BullMQ queue name. Shared by the producer (scheduler sweep) and the worker. */
export const DIGEST_QUEUE_NAME = "digest-jobs";

/** Produce a digest for one channel. slackChannelId is carried so the worker posts without a lookup. */
export interface ChannelDigestJob {
  type: "channel-digest";
  workspaceId: string;
  channelId: string;
  slackChannelId: string;
}

/**
 * The repeatable "sweep": fired on a schedule (not per-item), it enumerates the
 * channels worth digesting and fans out one ChannelDigestJob each. Carrying no
 * payload keeps the repeatable job single and idempotent.
 */
export interface DigestSweepJob {
  type: "digest-sweep";
}

export type DigestJob = ChannelDigestJob | DigestSweepJob;

/** A channel the sweep may enqueue a digest for. */
export interface DigestChannelRef {
  workspaceId: string;
  channelId: string;
  slackChannelId: string;
}

/** What a run records (Prisma-backed in production). Mirrors the DigestRun row minus id/runAt. */
export interface RecordedDigestRun {
  workspaceId: string;
  channelId: string;
  itemsConsidered: number;
  staleItems: number;
  summaryText: string | null;
  postedMessageTs: string | null;
}

/**
 * Persistence port for digests (Prisma-backed in production). Also serves the
 * sweep: `listDigestChannels` enumerates the channels worth a digest.
 */
export interface DigestStore {
  loadOpenItems(channelId: string): Promise<StaleItem[]>;
  recordRun(run: RecordedDigestRun): Promise<void>;
  /** Channels the bot can post to, in active workspaces, that have >=1 open item. */
  listDigestChannels(): Promise<DigestChannelRef[]>;
}

export interface DigestJobDeps {
  /** The channel's currently-open items (with createdAt, for the staleness cut). */
  loadOpenItems(channelId: string): Promise<StaleItem[]>;
  /** The Claude-backed prose summarizer. */
  model: DigestModel;
  /** Injected clock so the staleness decision is deterministic in tests. */
  clock(): Date;
  /** Post the digest to the channel; returns the message ts, or null if the post failed. */
  post(slackChannelId: string, summaryText: string, staleItems: number): Promise<string | null>;
  /** Persist the run (always — an empty run is useful signal). */
  recordRun(run: RecordedDigestRun): Promise<void>;
}

/**
 * Perform one channel's digest: load its open items, decide + write the digest,
 * post it when there's something to say, and record the run either way. Recording
 * an empty run (staleItems 0) is intentional — it shows the digest ran and found
 * nothing, and it's bounded because the sweep only enqueues channels with open
 * items. A failed post records the digest text with a null ts so the miss is
 * visible; any model/DB error propagates so BullMQ retries with backoff.
 */
export async function runChannelDigestJob(job: ChannelDigestJob, deps: DigestJobDeps): Promise<void> {
  const items = await deps.loadOpenItems(job.channelId);
  const outcome = await computeStaleDigest(items, deps.clock(), deps.model, job.workspaceId);

  let postedMessageTs: string | null = null;
  if (outcome.hasDigest && outcome.summaryText) {
    postedMessageTs = await deps.post(job.slackChannelId, outcome.summaryText, outcome.staleItems);
  }

  await deps.recordRun({
    workspaceId: job.workspaceId,
    channelId: job.channelId,
    itemsConsidered: outcome.itemsConsidered,
    staleItems: outcome.staleItems,
    summaryText: outcome.summaryText,
    postedMessageTs,
  });
}
