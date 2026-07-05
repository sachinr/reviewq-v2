# Reviewed v2 — Rebuilding a Slack Queue Bot for the AI/Agentic Era

## Context

**What this is today.** `reviewq-v2` is the codebase for "Reviewed," a small Slack app with real production traction: users flag any Slack message (via a message shortcut, `/command`, or `@bot add`) to drop it into a lightweight per-channel "queue" of things needing review — legal contracts, PRs, questions, anything. Someone marks it done, the original author gets notified, a ✅ reaction goes on the message, and there's a 1-minute undo window. Users can list/paginate the queue via slash command, a Block Kit modal, or the App Home tab. That's the entire product — "no boards, no burndown charts, just a list of messages that need a look."

**Why rebuild.** The implementation is ~2019-era Slack app engineering: raw `@slack/web-api` calls with no Bolt SDK, Express, TypeORM 0.2.x (long EOL), hand-rolled OAuth and hand-rolled request-signature verification, zero background-job infrastructure (every Slack call is synchronous fire-and-forget — a failed notification just silently vanishes), and a mix of legacy `attachments` UI and Block Kit. There is **no AI anywhere** in the current code. Meanwhile Slack's platform has moved dramatically: a first-class **Agents & Assistants** framework for conversational, streaming AI teammates now exists, along with new AI-oriented Block Kit blocks, message metadata, and (as of Feb 2026) Slack's own MCP server. The goal is a **full greenfield rebuild** — old product has been shut down, no data migration required — that keeps solving the exact same problem (turn a message into a tracked, completable to-do, for any team) but rebuilt on a modern stack and layered with an AI teammate that makes add/track/complete faster and smarter.

**Decisions already made** (do not relitigate):
1. **Data architecture**: keep our own Postgres database as the source of truth. Slack Lists API is *not* used as the system of record (may be considered later purely as an optional rendered view).
2. **AI ambition**: build a **full conversational AI teammate** via Slack's Assistant-thread platform, with streaming replies — running *alongside* the classic shortcut/button/modal UX, not replacing it.
3. **Product scope**: stay fully generic ("any team, any reviewable item") — no narrowing to a single vertical like code review.
4. **Migration**: none. Old product is shut down; this is greenfield.
5. **Ownership model**: items stay **channel-scoped** — no per-item assignee or due date. Staleness/"what's stuck" is derived from item age. (Dropped the "smart assignee suggestion" feature as a consequence.)
6. **Bot authors**: a flagged message authored by a bot/app stores a raw `authorSlackId` with a *nullable* `authorUserId` FK — no synthetic user rows.

---

## Implementation status

All work is committed to branch `claude/slack-tool-ai-rebuild-e1ll6r` (pushed to `origin`). Git history is the source of truth; this section is the human-readable summary. **44 tests passing, `tsc --noEmit` clean.**

**Environment note:** the build sandbox has **no Docker / Postgres / Redis / live Slack**. So DB/queue/OAuth integration tests run in **CI**, not locally; pure business logic is fully tested in-sandbox against fakes. Dependency versions resolved & verified: Bolt 4.7.3, Prisma 5.22, Anthropic SDK 0.32.1, BullMQ 5.79.

**Phase 1 — essentially complete.** Ports-and-adapters architecture (see `README.md` for the diagram): pure tested core depends only on interfaces; thin adapters bind Prisma / Slack WebClient / Bolt / Anthropic.
- Scaffold + `prisma/schema.prisma` (Workspace / AppUser / Channel / Item, channel-scoped, `status` enum, nullable `authorUserId` + raw `authorSlackId`; AssistantThread / AssistantMessage) + initial migration `prisma/migrations/0001_init`.
- Core (tested vs fakes): `services/itemService.ts` (10), `slack/queueRenderer.ts` + `slack/blocks.ts` (6), `slack/streamBridge.ts` (5), `slack/resolver.ts` (Slack-id → row resolution), `services/assistantService.ts` (thread memory + `Responder` port + canned stand-in), `crypto/tokenCipher.ts` (AES-256-GCM at-rest token encryption).
- Adapters (thin, I/O): `db/{prisma,itemRepository,workspaceStore,assistantStore}.ts`, `slack/slackClient.ts`, `slack/installationStore.ts` (Bolt OAuth), `slack/anthropicChat.ts`.
- Bolt wiring (`slack/app.ts`, `src/index.ts`, `src/config.ts`): OAuth install store; all classic surfaces — slash command, message action `message_action_add`, Mark-Done/Undo/paginate buttons, App Home, `member_joined_channel` welcome; and the **Assistant surface** — `threadStarted` (welcome + static suggested prompts) and `userMessage` (persists each turn, `setStatus("is thinking…")`, replies via a swappable `Responder`).

**Phase 2 — started.**
- `services/anthropicResponder.ts` (+ tests, vs a fake `AnthropicChat`): Anthropic-backed `StreamingResponder` implementing the same `Responder` port; exposes `replyStream()` (text-delta `AsyncIterable`) plus a `reply()` that assembles the full string. `slack/anthropicChat.ts` is the SDK adapter (model via `ANTHROPIC_MODEL`, default `claude-sonnet-5`). Selected when `ANTHROPIC_API_KEY` is set, else the canned Phase 1 responder.

**Immediate next — LIVE STREAMING (in progress):** the assistant's `userMessage` handler (`slack/app.ts:294-321`) currently posts the whole reply at once via `say(reply)`. Replace that final step with a **real Slack stream sink** wrapping `chat.startStream` / `chat.appendStream` / `chat.stopStream`, fed by `anthropicResponder.replyStream()` → `streamBridge.pumpStream()`, so replies render incrementally and rate-safely. Still persist the final assembled reply (`assistantService.addMessage`). `streamBridge` (batching + 429 backoff) and `replyStream` already exist and are tested — only the live sink + the handler swap remain. TDD: unit-test the sink's start/append/stop sequencing against a fake WebClient; the sink is the one genuinely new piece.

**Remaining after that (Phase 1 tail + infra):**
- BullMQ `notification-jobs` queue + `notificationWorker` (retry-safe outbound Slack calls) — integration test **gated on `REDIS_URL`** (CI-only).
- Adapter integration tests **gated on `DATABASE_URL`** (Prisma stores, real Postgres) — CI-only.
- CI workflow (GitHub Actions) with Postgres + Redis service containers; fixtures incl. adversarial prompt-injection fixtures scaffolded for Phase 2 gating.

Phases 2 (rest) – 4 (summaries, vague-detection, tool-calling teammate, semantic dedup, digests, stretch MCP/Workflow-steps) remain plan-text — see Phasing below.

---

## Recommended stack

- **Bolt for JavaScript (TypeScript)**, HTTP receiver (not Socket Mode — required for public Marketplace distribution). Bolt-JS has the more mature `Assistant` class and streaming (`chat.startStream/appendStream/stopStream`) support, and pairs naturally with Anthropic's TypeScript SDK for a single-language hot path (Slack event → LLM stream → Slack stream append).
- **Prisma + Postgres** replacing TypeORM 0.2.x. Add `pgvector` only when semantic dedup (Phase 3) actually ships.
- **BullMQ + Redis** for background jobs — the single biggest structural gap in the old app. Needed because: (a) Slack's 3-second interactivity ack window can never include a live LLM call, so every AI-touching path must ack immediately and do the model call in a job; (b) scheduled digests need a repeatable-job scheduler; (c) outbound notifications need retry-safety the old fire-and-forget calls never had.
- **Anthropic Claude** via `@anthropic-ai/sdk` — a fast/cheap tier for structured classification (vague-detection), a mid tier for conversational replies/digest prose. All calls go through one wrapper module that enforces workspace-scoped isolation, timeouts/retries, and cost logging per workspace.
- **Hosting**: containerized deploy (Fly.io or Render) with three processes from one image — `web` (Bolt HTTP receiver), `worker` (BullMQ workers), `scheduler` (repeatable-job producer, can fold into `worker` initially). Managed Postgres + managed Redis.
- Bolt's built-in `InstallationStore` (Prisma-backed) replaces the hand-rolled OAuth + signature verification entirely.

## Domain model (redesigned, lean — no speculative fields)

- **Workspace** (was `Team`): `slackTeamId`, `botTokenEncrypted` (old app stored plaintext — encrypt), `isActive` (old app never tracked `app_uninstalled`).
- **AppUser** (was `User`): drops six unused Slack profile flags (confirmed write-only in the old code).
- **Channel**: drops five unused shared/visibility flags for the same reason.
- **Item** (the core row): collapses `complete`/`completedById`/`dateCompleted` into a single `status` enum + `completedByUserId`/`completedAt`. Adds `sourceMetadataKey` (Slack message metadata) to correlate an item back to its source message more robustly than `(channelId, ts)`-only matching (kept as a fallback). Channel-scoped (no `assignedUserId`/`dueAt`). Bot authors via raw `authorSlackId` + nullable `authorUserId`.
- **New tables, one per AI feature**: `ItemSummary`, `ItemClarificationRequest` (what the long-dead `Item.vague` boolean was meant to become), `DuplicateCandidate` + `ItemEmbedding` (Phase 3), `AssistantThread` + `AssistantMessage` (durable conversational state), `DigestRun`.

## Feature plan: old → new

Every classic capability gets a direct, cleaner rebuild in Bolt (shortcut `add_to_queue`, `/command`, `@mention`/DM add, list+paginate, "View all" modal, App Home, complete+notify+✅-reaction, 1-minute undo, help, install/OAuth) — collapsing the two duplicate paginators into one shared `queueRenderer`, and moving fragile regex text-parsing toward Bolt's typed listener args plus structured LLM outputs.

**New AI capabilities (each speeds up or sharpens add/track/complete/notify — nothing AI-for-its-own-sake):**

1. **Conversational teammate** — Slack Assistant thread, tool-calling against the same `itemService` used by buttons, replies streamed via `chat.startStream/appendStream/stopStream`, "thinking…" via `assistant.threads.setStatus`. Channel/age-based queries: "add this to #legal's queue," "mark the Q3 contract done," "what's stuck in #legal," "summarize the oldest open items this week."
2. **Dynamic suggested prompts** — `setSuggestedPrompts()` from real per-channel state (open counts, oldest-item age).
3. **Auto-summarization on add** — long threads/messages get one LLM pass into `ItemSummary`.
4. **Vague-item detection** — structured classification flags unclear items and asks a clarifying question in-thread.
5. **Semantic duplicate detection** (Phase 3) — pgvector similarity search scoped to open items in the same channel only.
6. **Scheduled staleness digests** — a BullMQ repeatable job Claude-summarizes aging open items.

## Slack surfaces/scopes

Bot scopes: today's list (`app_mentions:read`, `chat:write`, `commands`, `reactions:*`, etc.) plus `assistant:write`, `metadata.message:read`, `channels:history`/`groups:history`. Events: today's set plus `app_uninstalled`, `assistant_thread_started`, `assistant_thread_context_changed`. Same shortcut/slash-command names as today for user continuity.

## Phasing

1. **Phase 1**: Bolt scaffold, Prisma core schema, OAuth via `InstallationStore`, full feature-parity rebuild, BullMQ for notification retry-safety, and an Assistant *skeleton* (thread lifecycle + streaming plumbing proven end-to-end with **no LLM latency yet**). The "did we actually rebuild parity" milestone — ship before any AI.
2. **Phase 2**: AI triage on the add path — summarization + vague-detection (`llm/client.ts` + `ItemSummary`/`ItemClarificationRequest`).
3. **Phase 3**: Full conversational tool-calling teammate, dynamic suggested prompts, semantic dedup (pgvector), scheduled digests.
4. **Phase 4 (stretch)**: Workflow Builder custom steps, optional Canvas digest view, optional Slack Lists rendered view, optional MCP server exposure.

## Key risks

- **Slack's 3-second ack window** can never include a live LLM call — every AI path must ack instantly and follow up via a background job. Hard architectural constraint.
- **LLM cost at public multi-workspace scale** — triage fires on every add across every install; need per-workspace rate limits or a paid tier decided before Phase 2 ships broadly.
- **Cross-workspace isolation** — every LLM prompt scoped to one workspace only; explicit guardrail in `llm/client.ts`, not call-site discipline.
- **Moderation/data-handling** — the Assistant and triage read arbitrary message content (legal contracts, etc.). Need a stated zero-retention position for LLM calls and a per-workspace opt-out of AI features (classic queue must work standalone).
- **Streaming rate limits** — `chat.appendStream` respects Slack's messaging rate limits; chunk-batching/backoff designed in from Phase 1 (done in `streamBridge`).
- **Prisma connection pooling** across three processes against one Postgres — plan for `pgbouncer`/Accelerate before production.
- **Prompt injection via untrusted message content.** The assistant does tool-calling and its context includes arbitrary Slack message text any member can write. Mitigation designed in, not bolted on: message/thread content always passed to the model as clearly-delimited *data* (never concatenated into the instruction prompt); destructive tool calls re-confirm with the requesting user when the instruction is ambiguous or sourced from quoted content; tool execution is permission-checked server-side regardless of what the model requests.
- **Authorization boundary inside the assistant.** A DM-based assistant thread must not become a side channel for reading private-channel queue contents the user has no access to. Every `itemService` tool call needs a `requestingUserId` enforced against real Slack channel membership, not just workspace scoping.

## Testing strategy (TDD, no reliance on live e2e Slack testing)

Slack, Postgres, Redis, and Claude are all external systems that are slow, non-deterministic, or unavailable in CI — so "manually click through a real Slack workspace" is only an occasional spot-check, never the primary verification. Instead:

- **Design for testability first.** Every module takes its external collaborators (`WebClient`, Prisma client, Anthropic client) as injected parameters/interfaces rather than reaching for Bolt's global singletons. This is what makes per-module red/green/refactor TDD possible.
- **TDD per module**: write the test against injected fakes first, watch it fail, implement, refactor.
- **Slack listener tests, no network**: invoke Bolt listeners directly with fake `{event, body, ack, respond, say, client}` args built from fixture JSON; a thin supertest layer (signed fixtures against Bolt's `ExpressReceiver`) verifies routing/ack/signature-verification.
- **DB-layer tests against a real (test) Postgres** in CI, not mocked.
- **Job/queue tests**: job *logic* unit-tested directly; a smaller number of integration tests run one job through a real (test) Redis + BullMQ.
- **LLM tests fixture-based and deterministic for CI**: mock the Anthropic client with canned structured responses for golden inputs (actionable / vague / long-thread / near-duplicate); a small non-blocking nightly suite replays the same set against the real Claude API to catch prompt drift (advisory only).
- **Streaming bridge tested in isolation**: `streamBridge`'s chunk-batching/backoff as a pure function, including a simulated 429 (done).
- **Prompt-injection tests** as first-class regression cases: golden fixtures include adversarial content and assert the assistant does *not* invoke a destructive tool call from quoted message data.
- **Manual verification remaining**: a short pre-release smoke pass in a private dev workspace for what can't be faithfully faked (real OAuth install, real Block Kit appearance, real Assistant-thread UI).
- Phase 1 "done" = full unit + fixture-driven integration suite green in CI for every listener/service/job. Phase 2/3 add golden-fixture LLM suites (incl. adversarial cases) as a merge gate.
