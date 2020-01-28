import {createConnection, getConnection } from "typeorm";

import {setupChannel, setupItem, setupTeam, setupUser} from "./helpers";

import {Channel} from "../entity/Channel";
import {Item} from "../entity/Item";
import {Message} from "../entity/Message";
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

test("paginates through open items", async () => {
  const team = await setupTeam().save();
  const channel = await setupChannel(team, false).save();
  const user = await setupUser(team).save();
  for (const i of [1, 2, 3, 4, 5, 6, 7]) {
    await setupItem(channel, user).save();
  }
  const message = new Message(channel);
  await message.addOpenItems(1, false);
  expect(message.attachments[3].actions.length).toBe(3);
  expect(message.attachments[3].actions[0].name).toBe("Next");
  expect(message.attachments[3].actions[1].name).toBe("Minimize");
  expect(message.attachments[3].actions[2].name).toBe("Sort");
  expect(message.attachments[3].footer).toBe("Page 1 of 3");

  const message2 = new Message(channel);
  await message2.addOpenItems(JSON.parse(message.attachments[3].actions[0].value).start, false);
  expect(message2.attachments[3].actions.length).toBe(3);
  expect(message2.attachments[3].actions[0].name).toBe("Next");
  expect(message2.attachments[3].actions[1].name).toBe("Previous");
  expect(message2.attachments[3].actions[2].name).toBe("Minimize");
  expect(message2.attachments[3].footer).toBe("Page 2 of 3");

  const message3 = new Message(channel);
  await message3.addOpenItems(JSON.parse(message2.attachments[3].actions[0].value).start, false);
  expect(message3.attachments[1].actions.length).toBe(2);
  expect(message3.attachments[1].actions[0].name).toBe("Previous");
  expect(message3.attachments[1].actions[1].name).toBe("Minimize");
  expect(message3.attachments[1].footer).toBe("Page 3 of 3");
});
