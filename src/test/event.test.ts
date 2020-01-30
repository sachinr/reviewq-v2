import {createConnection, getConnection, getRepository} from "typeorm";

import {setupChannel, setupTeam, setupUser} from "./helpers";

import {Channel} from "../entity/Channel";
import {Event} from "../entity/Event";
import {Item} from "../entity/Item";
import {Team} from "../entity/Team";
import {User} from "../entity/User";

jest.mock("@slack/web-api", () => ({
  WebClient: jest.fn(() => {
    return {
      chat: { postMessage: jest.fn() },
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

User.prototype.fetchProfile = jest.fn();

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

test("hasExistingTeam() finds team", async () => {
  const team = await setupTeam().save();
  const event = new Event();
  event.team_id = "T1234";
  expect(await event.findTeam()).toStrictEqual(team);
});

test("hasExistingTeam() doesn't find team", async () => {
  const team = await setupTeam().save();
  const event = new Event();
  event.team_id = "chicken";
  expect(await event.findTeam()).toStrictEqual(undefined);
});

test("findOrCreateSlackObjects() finds channel and user", async () => {
  const team = await setupTeam().save();
  const user = await setupUser(team).save();
  const channel = await setupChannel(team, false).save();
  const slackEvent = new Event();
  slackEvent.team_id = team.slackId;
  slackEvent.event = {
    attachments: [],
    channel: channel.slackId,
    event_ts: "123",
    text: "test",
    ts: "1234",
    type: "message",
    user: user.slackId,
  };

  await slackEvent.findOrCreateSlackObjects();
  expect(slackEvent.team.id).toBe(team.id);
  expect(slackEvent.user.id).toBe(user.id);
  expect(slackEvent.channel.id).toBe(channel.id);
});

test("findOrCreateSlackObjects() creates channel and user", async () => {
  const team = await setupTeam().save();
  const slackEvent = new Event();
  slackEvent.team_id = team.slackId;
  slackEvent.event = {
    attachments: [],
    channel: "C1234",
    event_ts: "123",
    text: "test",
    ts: "1234",
    type: "message",
    user: "U1234",
  };

  await slackEvent.findOrCreateSlackObjects();
  expect(slackEvent.user.id).toBe(1);
  expect(slackEvent.channel.id).toBe(1);
});

test("processes message events", async () => {
  const spy = jest.spyOn(Item, "createFromEvent");
  const team = await setupTeam().save();
  const user = await setupUser(team).save();
  const channel = await setupChannel(team, true).save();
  const slackEvent = new Event();
  slackEvent.team_id = team.slackId;
  slackEvent.event = {
    attachments: [],
    channel: channel.slackId,
    event_ts: "123",
    text: "add",
    ts: "1234",
    type: "message",
    user: user.slackId,
  };
  await slackEvent.processMessageEvent();
  expect(spy).toBeCalledTimes(1);
});

test("processes message events", async () => {
  const spy = jest.spyOn(Item, "createFromEvent");
  const team = await setupTeam().save();
  const user = await setupUser(team).save();
  const channel = await setupChannel(team, true).save();
  const slackEvent = new Event();
  slackEvent.team_id = team.slackId;
  slackEvent.event = {
    attachments: [],
    channel: channel.slackId,
    event_ts: "123",
    text: `<@${team.botSlackId}> add`,
    ts: "1234",
    type: "message",
    user: user.slackId,
  };
  await slackEvent.processMessageEvent();
  expect(spy).toBeCalledTimes(1);
});

test("isMessageType", async () => {
  const event = new Event();
  event.event = {
    attachments: [],
    channel: "",
    event_ts: "",
    text: "",
    ts: "",
    type: "message",
    user: "",
  };
  expect(event.isMessageType()).toBeTruthy();
  event.event.subtype = "message_changed";
  expect(event.isMessageType()).toBeFalsy();
  event.event.type = "app_mention";
  expect(event.isMessageType()).toBeTruthy();
});

test("isMemberJoined", async () => {
  const team = setupTeam();
  team.botSlackId = "bot_slack_id";
  const event = new Event();
  event.team = team;
  event.event = {
    attachments: [],
    channel: "",
    event_ts: "",
    text: "",
    ts: "",
    type: "member_joined_channel",
    user: "bot_slack_id",
  };
  expect(event.isMemberJoined()).toBeTruthy();
  event.event.user = "someone_else";
  expect(event.isMemberJoined()).toBeFalsy();
});

test("findUserCommands", async () => {
  const team = setupTeam();
  team.botSlackId = "bot_slack_id";
  const event = new Event();
  event.team = team;
  event.event = {
    attachments: [],
    channel: "",
    event_ts: "",
    text: "AdD something",
    ts: "",
    type: "message",
    user: "",
  };
  expect(event.findUserCommand()).toBe("directAdd");
  event.event.text = "<@bot_slack_id> add something";
  expect(event.findUserCommand()).toBe("atMentionAdd");
  event.event.text = "list items";
  expect(event.findUserCommand()).toBe("directList");
  event.event.text = "<@bot_slack_id> list something";
  expect(event.findUserCommand()).toBe("atMentionList");
  event.event.text = "gobbledy gook";
  expect(event.findUserCommand()).toBe("other");
});

test("posts help in channel", async () => {
  const team = await setupTeam().save();
  const channel = await setupChannel(team, false).save();
  channel.postHelpMessage = jest.fn();
  team.botSlackId = "bot_slack_id";

  const event = new Event();
  event.findOrCreateSlackObjects = jest.fn();
  event.team = team;
  event.channel = channel;
  event.event = {
    attachments: [],
    channel: "",
    event_ts: "",
    text: "<@bot_slack_id> help",
    ts: "",
    type: "message",
    user: "",
  };
  await event.processMessageEvent();
  expect(event.findUserCommand()).toBe("atMentionHelp");
  expect(channel.postHelpMessage).toBeCalledTimes(1);
});

test("posts help in DM", async () => {
  const team = await setupTeam().save();
  const channel = await setupChannel(team, true).save();
  channel.postHelpMessage = jest.fn();
  team.botSlackId = "bot_slack_id";

  const event = new Event();
  event.findOrCreateSlackObjects = jest.fn();
  event.team = team;
  event.channel = channel;
  event.event = {
    attachments: [],
    channel: channel.slackId,
    event_ts: "",
    text: "help",
    ts: "",
    type: "message",
    user: "",
  };
  await event.processMessageEvent();
  expect(event.findUserCommand()).toBe("other");
  expect(channel.postHelpMessage).toBeCalledTimes(1);
});
