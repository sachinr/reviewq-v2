// Pure unit tests for the notification-jobs handler. No Redis, no BullMQ — the
// same FakeSlackGateway the rest of the core uses stands in for the resolved
// per-workspace client. The durable transport (real Queue/Worker) is covered by
// the REDIS_URL-gated integration test alongside this one.

import { runNotificationJob, type CompletionDmJob } from "../../src/jobs/notificationQueue";
import { FakeSlackGateway } from "../fakes";

describe("runNotificationJob", () => {
  it("delivers a completion-dm as a postMessage to the recipient", async () => {
    const slack = new FakeSlackGateway();
    const job: CompletionDmJob = {
      type: "completion-dm",
      workspaceId: "ws_1",
      recipientSlackId: "U_AUTHOR",
      text: ":white_check_mark: Your message was marked as complete by <@U_C>",
    };

    await runNotificationJob(job, slack);

    const posts = slack.callsTo("postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0].args[0]).toBe("U_AUTHOR");
    expect(posts[0].args[1]).toContain("marked as complete");
  });

  it("propagates a delivery failure so BullMQ can retry (does not swallow)", async () => {
    const slack = new FakeSlackGateway();
    slack.postMessage = async () => {
      throw new Error("slack 503");
    };
    const job: CompletionDmJob = {
      type: "completion-dm",
      workspaceId: "ws_1",
      recipientSlackId: "U_AUTHOR",
      text: "hi",
    };

    await expect(runNotificationJob(job, slack)).rejects.toThrow(/503/);
  });
});
