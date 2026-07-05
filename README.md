# Reviewed v2

Turn any Slack message into a tracked, completable review item — with an AI
teammate layered on top. This is a ground-up rebuild of the classic app,
replacing the Express + TypeORM stack (fat entity models that doubled as Slack
API wrappers) with **Bolt + Prisma** and a testable, ports-and-adapters core.

## Architecture

The design keeps all business rules in pure, unit-tested modules that depend
only on interfaces (*ports*), with thin *adapters* binding them to Prisma, the
Slack WebClient, and Bolt.

```
Slack ──▶ Bolt listeners (src/slack/app.ts)
             │  resolve workspace/channel/user            core (pure, tested)
             ├─▶ resolver ──────────────┐          ┌──▶ itemService  ── queue rules
             │     (src/slack/resolver)  │          │     (src/services/itemService)
             ▼                           ▼          │
        adapters                      ports  ◀──────┤──▶ queueRenderer ── Block Kit
   PrismaItemRepository          (src/services/     │     (src/slack/queueRenderer)
   PrismaWorkspaceStore           ports.ts)         ├──▶ assistantService ── thread memory
   PrismaAssistantStore                             │     (src/services/assistantService)
   SlackClient (WebClient)                          └──▶ streamBridge ── rate-limited streaming
```

| Concern | Core (tested, no I/O) | Adapter (I/O) |
| --- | --- | --- |
| Queue rules (add/complete/undo/reopen, undo window) | `services/itemService.ts` | `db/itemRepository.ts`, `slack/slackClient.ts` |
| Queue rendering / pagination | `slack/queueRenderer.ts`, `slack/blocks.ts` | — |
| Slack id → row resolution | `slack/resolver.ts` | `db/workspaceStore.ts`, `slack/slackClient.ts` |
| Assistant thread memory | `services/assistantService.ts` | `db/assistantStore.ts` |
| Assistant reply generation | `services/anthropicResponder.ts` | `slack/anthropicChat.ts` (Anthropic SDK) |
| LLM streaming to Slack | `slack/streamBridge.ts`, `services/anthropicResponder.ts` (`replyStream`) | (live Slack stream sink: pending) |
| Token encryption at rest | `crypto/tokenCipher.ts` (AES-256-GCM) | — |
| OAuth install | — | `slack/installationStore.ts` (Bolt) |

### Slack surfaces (all in `src/slack/app.ts`)

- **Slash command** — posts the channel's queue (`private` → ephemeral).
- **Message action** _Add to review queue_ (`message_action_add`) — flags the
  message, handling bot/app authors without minting a synthetic user.
- **Buttons** — Mark as Done / Undo (60s window) / paginate, re-rendered in place.
- **App Home** — the user's queue.
- **member_joined_channel** — a welcome message when the bot is added.
- **Assistant** — persists every turn (`AssistantThread`/`AssistantMessage`) so
  context survives across messages; replies via a swappable `Responder`
  (`createAnthropicResponder` when `ANTHROPIC_API_KEY` is set, else the canned
  Phase 1 stand-in). The responder streams token deltas and exposes them as
  `replyStream` for `streamBridge`.

## Running locally

```bash
npm install
cp .env.example .env            # fill in Slack creds + generate TOKEN_ENCRYPTION_KEY
npx prisma migrate deploy       # apply prisma/migrations to your Postgres
npm run dev                     # ts-node-dev, http://localhost:3000
```

Point your Slack app's Redirect URL at `…/slack/oauth_redirect` and its Request
URL at `…/slack/events` (Bolt's HTTPReceiver mounts both). Install via
`…/slack/install`.

## Testing

```bash
npm test        # Jest — all core logic against in-memory fakes, no DB/Redis/Slack
npx tsc --noEmit
```

The pure core (`itemService`, `queueRenderer`, `streamBridge`, `resolver`,
`assistantService`, `anthropicResponder`, `tokenCipher`) is fully covered by
fakes in `test/` — the responder is tested against a fake `AnthropicChat`, so no
key or network is needed. The Prisma/WebClient/Anthropic adapters are
deliberately thin and exercised end-to-end when run against live services.

## Roadmap

- **Phase 1** — core queue, all Slack surfaces, OAuth, assistant skeleton.
- **Phase 2 (in progress)** — Anthropic-backed assistant reply generation
  (`anthropicResponder` + `anthropicChat`, token-streaming via `replyStream`);
  next: wire `replyStream` → `streamBridge` → a live Slack stream sink so replies
  render incrementally, then summaries, duplicate detection, and digests (BullMQ
  worker: `npm run start:worker`).
