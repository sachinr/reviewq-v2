import {getRepository} from "typeorm";
import {Channel} from "../entity/Channel";
import {Team} from "../entity/Team";
import {User} from "../entity/User";

export const setupTeam = async () => {
  const team = new Team();
  team.name = "LLL";
  team.slackId = "T1234";
  team.botSlackId = "B1234";
  team.botToken = "xoxb-1234-1234";
  team.scope = "app_mention,users:read";
  await getRepository(Team).save(team);

  return team;
};

export const setupUser = async (team: Team) => {
  const user = new User();
  user.firstName = "Joe";
  user.lastName = "Shmoe";
  user.team = team;
  user.slackId = "U1234";
  user.displayName = "joeshmoe";

  await getRepository(User).save(user);

  return user;
};

export const setupChannel = async (team: Team, isIm: boolean) => {
  const channel = new Channel();
  isIm ? channel.slackId = "D1234" : channel.slackId = "C1234";
  channel.team = team;

  await getRepository(Channel).save(channel);

  return channel;
};
