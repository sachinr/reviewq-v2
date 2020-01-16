import {createConnection, getConnection, getRepository} from "typeorm";

import {setupChannel, setupTeam, setupUser} from "./helpers";

import {Channel} from "../entity/Channel";
import {Event} from "../entity/Event";
import {Item} from "../entity/Item";
import {Team} from "../entity/Team";
import {User} from "../entity/User";

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
    channel: channel.slackId,
    event_ts: "123",
    text: "add",
    ts: "1234",
    type: "message",
    user: user.slackId,
  };
  await slackEvent.process();
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
    channel: channel.slackId,
    event_ts: "123",
    text: `<@${team.botSlackId}> add`,
    ts: "1234",
    type: "message",
    user: user.slackId,
  };
  await slackEvent.process();
  expect(spy).toBeCalledTimes(1);
});