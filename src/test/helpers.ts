import { Channel } from "../entity/Channel";
import { Item } from "../entity/Item";
import { Team } from "../entity/Team";
import { User } from "../entity/User";

const randomString = () => {
  return Math.random().toString(36).substring(2, 15);
};

export const setupTeam = () => {
  const team = new Team();
  team.name = randomString();
  team.slackId = "T1234";
  team.botSlackId = "B1234";
  team.botToken = "xoxb-1234-1234";
  team.scope = "app_mention,users:read";

  return team;
};

export const setupUser = (team: Team) => {
  const user = new User();
  user.firstName = "Joe";
  user.lastName = randomString();
  user.teamId = team.id;
  user.slackId = "U" + randomString();
  user.displayName = "joeshmoe";

  return user;
};

export const setupChannel = (team: Team, isIm: boolean) => {
  const channel = new Channel();
  isIm ? channel.slackId = "D" + randomString() : channel.slackId = "C" + randomString();
  channel.team = team;

  return channel;
};

export const setupItem = (channel: Channel, user: User) => {
  const item = new Item();
  item.channel = channel;
  item.ts = "1234.123";
  item.message = randomString();
  item.user = user;

  return item;
};
