import { WebAPICallResult, WebClient } from "@slack/web-api";
import {BaseEntity, Column, Entity, OneToMany, PrimaryGeneratedColumn} from "typeorm";
import {Channel} from "./Channel";
import {User} from "./User";

interface ITeamInfoCallResult extends WebAPICallResult {
  team: {
    id: string;
    name: string;
    domain: string;
    email_domain: string;
    enterprise_id: string;
    enterprise_name: string;
  };
}

@Entity()
export class Team extends BaseEntity {

  @PrimaryGeneratedColumn()
  public id: number;

  @Column()
  public name: string;

  @Column()
  public slackId: string;

  @Column({ nullable: true })
  public slackEnterpriseId: string;

  @Column({ nullable: true })
  public scope: string;

  @Column({ nullable: true })
  public botSlackId: string;

  @Column({ nullable: true })
  public botToken: string;

  @OneToMany((type) => User, (user) => user.team)
  public users: User[];

  @OneToMany((type) => Channel, (channel) => channel.team)
  public channels: Channel[];

  public async fetchInfo(slackId: string, botToken: string) {
    try {
      const client = new WebClient(botToken);
      const result = await client.team.info({
        team: slackId,
      }) as ITeamInfoCallResult;

      this.slackId = result.team.id;
      this.name = result.team.name;
      this.slackEnterpriseId = result.team.enterprise_id;
      await this.save();

      return this;
    } catch (error) {
      // tslint:disable-next-line: no-console
      console.log(error);
    }

  }
}
