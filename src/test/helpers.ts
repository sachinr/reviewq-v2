import { Channel } from "../entity/Channel";
import { Item } from "../entity/Item";
import { Team } from "../entity/Team";
import { User } from "../entity/User";

export const setupTeam = () => {
  const team = new Team();
  team.name = "LLL";
  team.slackId = "T1234";
  team.botSlackId = "B1234";
  team.botToken = "xoxb-1234-1234";
  team.scope = "app_mention,users:read";

  return team;
};

export const setupUser = (team: Team) => {
  const user = new User();
  user.firstName = "Joe";
  user.lastName = "Shmoe";
  user.team = team;
  user.slackId = "U1234";
  user.displayName = "joeshmoe";

  return user;
};

export const setupChannel = (team: Team, isIm: boolean) => {
  const channel = new Channel();
  isIm ? channel.slackId = "D1234" : channel.slackId = "C1234";
  channel.teamId = team.id;

  return channel;
};

export const setupItem = (channel: Channel, user: User) => {
  const item = new Item();
  item.channel = channel;
  item.ts = "1234.123";
  item.message = "test message";
  item.user = user;

  return item;
};
