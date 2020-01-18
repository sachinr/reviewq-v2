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

  const item = Item.createFromEvent(slackEvent);
  expect(item.channel.id).toBe(1);
});
