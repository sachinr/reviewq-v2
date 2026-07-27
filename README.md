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
| LLM streaming to Slack | `slack/streamBridge.ts`, `services/anthropicResponder.ts` (`replyStream`), `services/assistantService.ts` (`handleUserMessageStreaming`) | `slack/slackStreamSink.ts` (chat.startStream/appendStream/stopStream) |
| Token encryption at rest | `crypto/tokenCipher.ts` (AES-256-GCM) | — |
| OAuth install | — | `slack/installationStore.ts` (Bolt) |
| Retry-safe outbound notifications | `jobs/notificationQueue.ts` (`runNotificationJob`, pure) | `jobs/bullNotificationQueue.ts` (BullMQ producer), `jobs/worker.ts` (consumer) |

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
  Phase 1 stand-in). The responder streams token deltas via `replyStream`, which
  `handleUserMessageStreaming` pumps through `streamBridge` into a live
  `slackStreamSink` so replies render incrementally in the thread.

## Running locally

Fastest path — everything (Postgres, Redis, web, worker) via Docker Compose:

```bash
cp .env.example .env            # fill in Slack creds + TOKEN_ENCRYPTION_KEY (+ ANTHROPIC_API_KEY)
docker compose up --build       # db, redis, web (:3000), worker
docker compose run --rm web npm run migrate:deploy   # apply migrations (first run only)
```

Compose overrides `DATABASE_URL`/`REDIS_URL` to the compose network, so you don't
provision anything. It's a **dev/smoke-test** stack, not the production path (prod
is a PaaS + managed data stores — see Deployment).

Prefer running against your own Postgres/Redis instead:

```bash
npm install
cp .env.example .env            # fill in Slack creds + generate TOKEN_ENCRYPTION_KEY
npx prisma migrate deploy       # apply prisma/migrations to your Postgres
npm run dev                     # web: ts-node-dev, http://localhost:3000
npm run start:worker            # worker: drains the notification/triage/digest queues (needs Redis)
```

The **web** process acks Slack and enqueues outbound notifications; the
**worker** process delivers them with retry/backoff. Both share one image and one
Postgres/Redis — run the worker whenever you exercise completions so the author
DM actually goes out.

To reach Slack, point a tunnel (ngrok / cloudflared) at `localhost:3000` and set
the app's Request/Redirect URLs to it.

Point your Slack app's Redirect URL at `…/slack/oauth_redirect` and its Request
URL at `…/slack/events` (Bolt's HTTPReceiver mounts both). Install via
`…/slack/install`.

## Deployment

The app runs as **two processes from one build**: `web` (Bolt HTTP receiver) and
`worker` (BullMQ notification consumer). It needs a **Postgres** and a **Redis**,
and a **public HTTPS URL** Slack can reach.

**1. Create the Slack app.** At [api.slack.com/apps](https://api.slack.com/apps)
→ *Create New App* → *From a manifest*, paste `slack-manifest.json` and replace
every `YOUR_HOST` with your deployed host. It declares the scopes, events, the
`/reviewed` command, the *Add to review queue* message shortcut, App Home, and
the Assistant view — all matched to the code. Grab the **Signing Secret**,
**Client ID**, and **Client Secret** from *Basic Information*. (If the Assistant
container doesn't appear, toggle *Agents & Assistants* on in the app's feature
settings — the manifest key can lag the UI.)

**2. Set env vars** (see `.env.example` for the full list):

| Var | Notes |
| --- | --- |
| `SLACK_SIGNING_SECRET`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | from the Slack app |
| `SLACK_STATE_SECRET` | any random string (signs the OAuth state param) |
| `TOKEN_ENCRYPTION_KEY` | 32 bytes — `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `DATABASE_URL`, `REDIS_URL` | managed Postgres + Redis |
| `ANTHROPIC_API_KEY` | optional — without it the assistant uses the canned (non-AI) responder |
| `PORT`, `NODE_ENV`, `APP_NAME` | `NODE_ENV=production` in prod |

**3. Migrate + run.** Apply migrations on each release, then start both roles:

```bash
npm run migrate:deploy     # prisma migrate deploy (release step)
npm start                  # web
npm run start:worker       # worker (separate process/service)
```

**Docker** (`Dockerfile` + `.dockerignore`): the build stage runs
`prisma generate` + `tsc`; the runtime image defaults to the web role. Run the
worker from the same image with `command: npm run start:worker`. Example:

```bash
docker build -t reviewed .
docker run -p 3000:3000 --env-file .env reviewed                 # web
docker run --env-file .env reviewed npm run start:worker         # worker
```

**Buildpack platforms** (Heroku / Render / Railway) use the `Procfile`: `web`,
`worker`, and a `release: npm run migrate:deploy` step that applies migrations
before the new release goes live. `postinstall` runs `prisma generate`
automatically on install.

**4. Point Slack at the host.** After the first deploy, confirm the app's Request
URL (`…/slack/events`) and Redirect URL (`…/slack/oauth_redirect`) match the live
host, then install via `…/slack/install`.

> Not yet verified against a live workspace: the streaming path assumes Slack's
> `chat.*Stream` `markdown_text` parameter and the `claude-sonnet-5` model id
> (override with `ANTHROPIC_MODEL`). Smoke-test both on first install.

## Testing

```bash
npm test        # Jest — all core logic against in-memory fakes, no DB/Redis/Slack
npx tsc --noEmit
npm run lint
```

The pure core (`itemService`, `queueRenderer`, `streamBridge`, `resolver`,
`assistantService`, `anthropicResponder`, `slackStreamSink`, `tokenCipher`,
`jobs/notificationQueue`) is fully covered by fakes in `test/` — the responder is
tested against a fake `AnthropicChat`, and the live stream sink against a fake
`chat.*Stream` client, so no key or network is needed.

The Prisma/WebClient/Anthropic adapters are deliberately thin and exercised
end-to-end by **integration suites gated on env vars**: `*.integration.test.ts`
under `test/db` runs the Prisma stores against a real Postgres when `DATABASE_URL`
is set, and `test/jobs/notificationQueue.integration.test.ts` round-trips a job
through a real Redis when `REDIS_URL` is set. With neither set (the default
sandbox) they `describe.skip` rather than fail. `.github/workflows/ci.yml` spins
up Postgres + Redis service containers, migrates, then runs the whole suite so
those gated tests actually execute in CI. `test/fixtures/prompt-injection/`
scaffolds the adversarial golden fixtures the Phase 2 tool-calling suite will
gate on.

## Roadmap

- **Phase 1** — core queue, all Slack surfaces, OAuth, assistant skeleton. ✅
- **Phase 2** — Anthropic-backed assistant replies streamed end-to-end
  (`replyStream` → `streamBridge` → `slackStreamSink`), plus AI triage on the add
  path (summaries + vague-item detection). ✅
- **Phase 3** — conversational tool-using assistant (multi-turn tool-use loop +
  guarded confirmation UI) ✅; **scheduled staleness digests** — a repeatable
  BullMQ sweep that Claude-summarizes each channel's aging open items and posts a
  digest (`DIGEST_CRON`, default Mondays 14:00 UTC; runs on the worker process). ✅
- **Next** — cross-channel assistant reads, dynamic suggested prompts, semantic
  duplicate detection (pgvector); stretch: Workflow Builder steps, MCP exposure.
