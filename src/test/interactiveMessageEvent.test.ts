import {createConnection, getConnection, getRepository} from "typeorm";

import {setupChannel, setupItem, setupTeam, setupUser} from "./helpers";

import {Channel} from "../entity/Channel";
import {IAction, InteractiveMessageEvent} from "../entity/InteractiveMessageEvent";
import {Item} from "../entity/Item";
import {Team} from "../entity/Team";
import {User} from "../entity/User";

jest.mock("@slack/web-api", () => ({
  WebClient: jest.fn(() => {
    return {
      chat: {
        getPermalink: jest.fn(() => {
          return { ok: true };
        }),
        postMessage: jest.fn(),
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

test("constructor", async () => {
  const action = {name: "name", type: "type", value: "value"};
  let event = new InteractiveMessageEvent({ actions: [action]});
  expect(event.initiatingAction.name).toBe(action.name);
  expect(event.initiatingAction.type).toBe(action.type);
  expect(event.initiatingAction.value).toBe(action.value);

  event = new InteractiveMessageEvent({});
  expect(event.initiatingAction.name).toBe("Message Action");
});

test("completeItem", async () => {
  const team = await setupTeam().save();
  const channel = await setupChannel(team, false).save();
  const user = await setupUser(team).save();
  const item = await setupItem(channel, user).save();
  const completeButtonValue = {
    itemId: item.id,
    itemTs: item.ts,
    reverse: false,
    start: 1,
  };
  const action = {name: "name", type: "type", action_id: JSON.stringify({completeButtonValue})} as IAction;
  const event = new InteractiveMessageEvent({
    actions: [action],
    channel_id: channel.slackId,
    team_id: team.slackId,
    user_id: user.slackId,
  });
  expect(item.complete).toBe(false);
  await event.completeItem();
  await item.reload();
  expect(item.complete).toBe(true);
});

test("undoCompleteItem", async () => {
  const team = await setupTeam().save();
  const channel = await setupChannel(team, false).save();
  const user = await setupUser(team).save();
  const item = setupItem(channel, user);
  item.complete = true;
  await item.save();
  const completeButtonValue = {
    itemId: item.id,
    itemTs: item.ts,
    reverse: false,
    start: 1,
  };
  const action = {name: "name", type: "type", action_id: JSON.stringify({completeButtonValue})} as IAction;
  const event = new InteractiveMessageEvent({
    actions: [action],
    channel_id: channel.slackId,
    team_id: team.slackId,
    user_id: user.slackId,
  });
  expect(item.complete).toBe(true);
  await event.undoCompleteItem();
  await item.reload();
  expect(item.complete).toBe(false);
});

test("paginate - close list", async () => {
  const closeButtonValue = {
    reverse: false,
    start: 1,
    text: "close",
  };
  const action = { name: "name", type: "type", action_id: JSON.stringify(closeButtonValue) };
  const event = new InteractiveMessageEvent({ actions: [action] });
  event.channel = new Channel();
  event.channel.deleteMessage = jest.fn();
  event.findOrCreateSlackObjects = jest.fn();
  event.message_ts = "message_ts";
  event.response_url = "response_url";
  await event.paginate();
  expect(event.channel.deleteMessage).toBeCalledTimes(1);
  expect(event.channel.deleteMessage).toBeCalledWith("message_ts", "response_url");
});

test("paginate - next or previous", async () => {
  const paginationButtonValue = {
    reverse: false,
    start: 1,
    text: "Next",
  };
  const action = { name: "name", type: "type", action_id: JSON.stringify(paginationButtonValue) };
  const event = new InteractiveMessageEvent({ actions: [action] });
  event.channel = new Channel();
  event.channel.postItemsList = jest.fn();
  event.response_url = "response_url";
  await event.paginate();
  expect(event.channel.postItemsList).toBeCalledTimes(1);
  expect(event.channel.postItemsList).toBeCalledWith(1, false, "response_url");
});
