// Central, validated config surface. Everything that reads process.env goes
// through here so that (a) a missing var fails loudly at boot rather than as a
// mysterious runtime undefined, and (b) tests can construct a config object
// directly instead of mutating global env. Values that only some code paths
// need (Redis, Anthropic) are lazy — accessed via helpers that throw only when
// actually required — so unit tests and the web process don't have to set
// worker-only vars.

import dotenv from "dotenv";

dotenv.config();

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export interface Config {
  nodeEnv: string;
  port: number;
  slack: {
    signingSecret: string;
    clientId: string;
    clientSecret: string;
    stateSecret: string;
    scopes: string[];
    userScopes: string[];
  };
  tokenEncryptionKey: string;
  databaseUrl: string;
  redisUrl: string;
  anthropicApiKey: string;
  appName: string;
}

// Bot scopes carried over verbatim from the classic app's OAuthController so an
// existing install re-authorizes with an identical grant.
export const BOT_SCOPES = [
  "app_mentions:read",
  "channels:join",
  "channels:read",
  "chat:write",
  "commands",
  "groups:read",
  "im:history",
  "im:read",
  "mpim:read",
  "reactions:read",
  "reactions:write",
  "team:read",
  "users:read",
  // New in v2: the Assistant surface needs assistant:write to post into the
  // assistant thread and stream replies.
  "assistant:write",
  // Phase 2: reading thread/message content for auto-summarization and vague-item
  // detection, plus message metadata to correlate an item back to its source
  // message (Item.sourceMetadataKey) more robustly than (channelId, ts) alone.
  // These require re-consent, so they're added ahead of the features that use them.
  "channels:history",
  "groups:history",
  "mpim:history",
  "metadata.message:read",
];

export const USER_SCOPES = ["channels:read", "groups:read", "mpim:read", "im:read"];

export function loadConfig(): Config {
  return {
    nodeEnv: optional("NODE_ENV", "development"),
    port: Number(optional("PORT", "3000")),
    slack: {
      signingSecret: required("SLACK_SIGNING_SECRET"),
      clientId: required("SLACK_CLIENT_ID"),
      clientSecret: required("SLACK_CLIENT_SECRET"),
      stateSecret: optional("SLACK_STATE_SECRET", "reviewed-oauth-state"),
      scopes: BOT_SCOPES,
      userScopes: USER_SCOPES,
    },
    tokenEncryptionKey: required("TOKEN_ENCRYPTION_KEY"),
    databaseUrl: required("DATABASE_URL"),
    redisUrl: optional("REDIS_URL", "redis://127.0.0.1:6379"),
    anthropicApiKey: optional("ANTHROPIC_API_KEY"),
    appName: optional("APP_NAME", "Reviewed"),
  };
}
