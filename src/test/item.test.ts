import {createConnection, getConnection, getRepository} from "typeorm";

import {setupChannel, setupItem, setupTeam, setupUser} from "./helpers";

import { Channel } from "../entity/Channel";
import { Event } from "../entity/Event";
import { Item } from "../entity/Item";
import { Team } from "../entity/Team";
import { User } from "../entity/User";

import { WebClient } from "@slack/web-api";

const postMessage = jest.fn();

jest.mock("@slack/web-api", () => ({
  WebClient: jest.fn(() => {
    return {
      chat: { postMessage },
      conversations: {
        info: jest.fn(() => {
          return { ok: true, channel: { is_channel: true } };
        }),
      },
      team: {
        info: jest.fn(() => {
          return { ok: true, team: { domain: "testsuite.com" } };
        }),
      },
    };
  }),
}));

beforeEach(() => {
  return createConnection({
    database: ":memory:",
    dropSchema: true,
    entities: [User, Team, Item, Channel],
    logging: false,
    synchronize: true,
    type: "sqlite",
  });
});

afterEach(() => {
  jest.clearAllMocks();
  const conn = getConnection();
  return conn.close();
});

test("create from event", async () => {
  const team = await setupTeam().save();
  const user = await setupUser(team).save();
  const channel = await setupChannel(team, true).save();
  const slackEvent = new Event();
  slackEvent.team_id = team.slackId;
  slackEvent.event = {
    channel: channel.slackId,
    event_ts: "123",
    text: "add",
    ts: "1234",
    type: "message",
    user: user.slackId,
  };
  await slackEvent.findOrCreateSlackObjects();

  const item = await Item.createFromEvent(slackEvent);
  expect(item.channel.id).toBe(1);
});

test("cleans message", async () => {
  const team = await setupTeam().save();
  const user = await setupUser(team).save();
  const channel = await setupChannel(team, true).save();
  const slackEvent = new Event();
  slackEvent.team_id = team.slackId;
  slackEvent.event = {
    channel: channel.slackId,
    event_ts: "123",
    text: "add something",
    ts: "1234",
    type: "message",
    user: user.slackId,
  };
  await slackEvent.findOrCreateSlackObjects();

  const item = await Item.createFromEvent(slackEvent);
  expect(item.message).toBe("something");

  slackEvent.event.text = "Add something";
  slackEvent.event.ts = "12345";
  const item2 = await Item.createFromEvent(slackEvent);

  expect(item2.message).toBe("something");

  slackEvent.event.text = `<@${(team.botSlackId)}> add something`;
  slackEvent.event.ts = "123456";
  const item3 = await Item.createFromEvent(slackEvent);

  expect(item3.message).toBe("something");

  slackEvent.event.text = `<@${(team.botSlackId)}> something`;
  slackEvent.event.ts = "1234567";
  const item4 = await Item.createFromEvent(slackEvent);

  expect(item4.message).toBe("something");
});

test("mark complete", async () => {
  const team = await setupTeam().save();
  const user = await setupUser(team).save();
  const user2 = await setupUser(team).save();
  const channel = await setupChannel(team, true).save();
  const item = await setupItem(channel, user).save();

  await item.markComplete(user2);

  expect(item.complete).toBeTruthy();
  expect(item.completedBy.id).toBe(user2.id);
});

test("notify", async () => {
  const team = await setupTeam().save();
  const user = await setupUser(team).save();
  const user2 = await setupUser(team).save();
  const channel = await setupChannel(team, true).save();
  const item = await setupItem(channel, user).save();

  await item.markComplete(user2);
  await item.notify("completed");

  expect(postMessage).toHaveBeenCalledTimes(1);
  expect(postMessage).toBeCalledWith({
    attachments: [],
    blocks: [],
    channel: user.slackId,
    mrkdwn: true,
    text: `${item.archiveLink} was marked as complete by <@${user2.slackId}>`,
  });
});
