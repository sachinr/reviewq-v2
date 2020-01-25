import crypto from "crypto";
import timingSafeCompare from "tsscmp";

export function verifySignature(req: any): boolean {
  const rawBody = req.rawBody;

  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const requestSignature = req.headers["x-slack-signature"] as string;
  const requestTimestamp = parseInt(req.headers["x-slack-request-timestamp"] as string, 10);
  // convert the current time to seconds (to match the API's `ts` format), then subtract 5 minutes' worth of seconds.
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - (60 * 5);

  if (requestTimestamp < fiveMinutesAgo) {
    throw new Error("Slack request signing verification outdated");
  }

  const hmac = crypto.createHmac("sha256", signingSecret);
  const [version, hash] = requestSignature.split("=");
  hmac.update(`${version}:${requestTimestamp}:${rawBody}`);

  if (timingSafeCompare(hash, hmac.digest("hex"))) {
    return true;
  } else {
    throw new Error(`Signature verification failed. Expected [${hash}] // Received [${hmac.digest("hex")}]`);
  }
}
