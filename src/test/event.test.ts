import {createConnection, getConnection, getRepository} from "typeorm";

import {setupChannel, setupTeam, setupUser} from "./helpers";

import {Channel} from "../entity/Channel";
import {Event} from "../entity/Event";
import {Item} from "../entity/Item";
import {Team} from "../entity/Team";
import {User} from "../entity/User";

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
  const conn = getConnection();
  return conn.close();
});

test("hasExistingTeam() finds team", async () => {
  const team = await setupTeam();
  const event = new Event();
  event.team_id = "T1234";
  expect(await event.findTeam()).toStrictEqual(team);
});

test("hasExistingTeam() doesn't find team", async () => {
  const team = await setupTeam();
  const event = new Event();
  event.team_id = "chicken";
  expect(await event.findTeam()).toStrictEqual(undefined);
});

test("findOrCreateSlackObjects()", async () => {
  const team = await setupTeam();
  const user = await setupUser(team);
  const channel = await setupChannel(team, false);
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
})