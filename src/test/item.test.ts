import {createConnection, getConnection, getRepository} from "typeorm";

import {setupChannel, setupItem, setupTeam, setupUser} from "./helpers";

import { Channel } from "../entity/Channel";
import { Event } from "../entity/Event";
import { Item } from "../entity/Item";
import { Team } from "../entity/Team";
import { User } from "../entity/User";

import { WebClient } from "@slack/web-api";
import { InteractiveMessageEvent } from "../entity/InteractiveMessageEvent";

const postMessage = jest.fn();
const getPermalink = jest.fn(() => {
  return { ok: true };
});

jest.mock("@slack/web-api", () => ({
  WebClient: jest.fn(() => {
    return {
      chat: {
        getPermalink,
        postMessage,
      },
      conversations: {
        info: jest.fn(() => {
          return { ok: true, channel: { is_channel: true } };
        }),
      },
      reactions: { add: jest.fn(), remove: jest.fn() },
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
    blocks: [],
    bot_id: "",
    channel: channel.slackId,
    event_ts: "123",
    team: "",
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
    blocks: [],
    bot_id: "",
    channel: channel.slackId,
    event_ts: "123",
    team: "",
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

test("createFromInteractiveMessage - new item", async () => {
  const event = new InteractiveMessageEvent({});
  const team = await setupTeam().save();
  const channel = await setupChannel(team, false).save();
  const user = await setupUser(team).save();

  event.channel = channel;
  event.actionUser = user;
  event.messageUser = user;
  event.message = {
    blocks: [],
    bot_id: "",
    team: "",
    text: "message_text",
    ts: "message_ts",
    type: "",
    user: "",
  };

  const item = await Item.createFromInteractiveMessage(event);
  expect(item.channel).toStrictEqual(channel);
  expect(item.user).toStrictEqual(user);
  expect(item.message).toBe("message_text");
  expect(item.ts).toBe("message_ts");
});

test("createFromInteractiveMessage - new item different users", async () => {
  const event = new InteractiveMessageEvent({});
  const team = await setupTeam().save();
  const channel = await setupChannel(team, false).save();
  const user = await setupUser(team).save();
  const user2 = await setupUser(team).save();

  event.channel = channel;
  event.actionUser = user;
  event.messageUser = user2;
  event.message = {
    blocks: [],
    bot_id: "",
    team: "",
    text: "message_text",
    ts: "message_ts",
    type: "",
    user: "",
  };

  const item = await Item.createFromInteractiveMessage(event);
  expect(item.channel).toStrictEqual(channel);
  expect(item.user).toStrictEqual(user2);
  expect(item.createdBy).toStrictEqual(user);
  expect(item.message).toBe("message_text");
  expect(item.ts).toBe("message_ts");
});


test("createFromInteractiveMessage - previously closed item", async () => {
  const event = new InteractiveMessageEvent({});
  const team = await setupTeam().save();
  const channel = await setupChannel(team, false).save();
  const user = await setupUser(team).save();
  const item = await setupItem(channel, user).save();
  await item.markComplete(user);

  event.channel = channel;
  event.message = {
    blocks: [],
    bot_id: "",
    team: "",
    text: "",
    ts: item.ts,
    type: "",
    user: "",
  };

  const item2 = await Item.createFromInteractiveMessage(event);
  expect(item.id).toBe(item2.id);
  expect(item2.complete).toBe(false);
});

test("createFromInteractiveMessage - currently open item", async () => {
  const event = new InteractiveMessageEvent({});
  const team = await setupTeam().save();
  const channel = await setupChannel(team, false).save();
  const user = await setupUser(team).save();
  const item = await setupItem(channel, user).save();

  event.channel = channel;
  event.message = {
    blocks: [],
    bot_id: "",
    team: "",
    text: "",
    ts: item.ts,
    type: "",
    user: "",
  };

  const item2 = await Item.createFromInteractiveMessage(event);
  expect(item.id).toBe(item2.id);
  expect(item2.complete).toBe(false);
});

test("createArchiveLink", async () => {
  const event = new InteractiveMessageEvent({});
  const team = await setupTeam().save();
  const channel = await setupChannel(team, false).save();
  const user = await setupUser(team).save();
  const item = setupItem(channel, user);

  await item.save();
  expect(getPermalink).toBeCalledTimes(1);
});

test("markNotComplete", async () => {
  const event = new InteractiveMessageEvent({});
  const team = await setupTeam().save();
  const channel = await setupChannel(team, false).save();
  const user = await setupUser(team).save();
  const item = await setupItem(channel, user).save();

  await item.markComplete(user);
  expect(item.complete).toBeTruthy();
  expect(item.completedBy).toStrictEqual(user);

  await item.markNotComplete();
  expect(item.complete).toBeFalsy();
  expect(item.completedBy).toBeNull();
});
