import { BaseEntity, Column, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn, Unique } from "typeorm";

import { Item } from "./Item";
import { Team } from "./Team";

@Unique(["slackId", "teamId"])
@Entity()
export class Channel extends BaseEntity {

  @PrimaryGeneratedColumn()
  public id: number;

  @Column()
  public slackId: string;

  @Column()
  public teamId: number;

  @ManyToOne((type) => Team, (team) => team.channels)
  public team: Team;

  @OneToMany((type) => Item, (item) => item.channel)
  public items: Item[];
}
