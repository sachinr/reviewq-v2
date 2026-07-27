// Web process entrypoint. Loads config, opens the shared Prisma connection,
// builds the Bolt app (which registers every Slack listener and mounts the
// OAuth install routes via Bolt's HTTPReceiver), and starts listening. The
// classic app's hand-rolled Express receiver, signature helper, and OAuth
// controller are all subsumed by Bolt here.

import { loadConfig } from "./config";
import { createTokenCipher } from "./crypto/tokenCipher";
import { prisma } from "./db/prisma";
import { createApp } from "./slack/app";

async function main(): Promise<void> {
  const config = loadConfig();
  const cipher = createTokenCipher(config.tokenEncryptionKey);
  const app = createApp({ prisma, cipher, config });

  await app.start(config.port);
  // eslint-disable-next-line no-console
  console.log(`⚡️ Reviewed is running on port ${config.port} (${config.nodeEnv})`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal startup error", err);
  process.exit(1);
});
