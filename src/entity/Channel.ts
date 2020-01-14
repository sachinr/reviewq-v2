import {BaseEntity, Column, Entity, ManyToOne, PrimaryGeneratedColumn} from "typeorm";

import {Team} from "./Team";

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
}
