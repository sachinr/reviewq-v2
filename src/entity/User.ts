import {BaseEntity, Column, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn} from "typeorm";

import {Item} from "./Item";
import {Team} from "./Team";

@Entity()
export class User extends BaseEntity {

  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ nullable: true })
  public teamId: number;

  @Column({ unique: true })
  public slackId: string;

  @Column({ nullable: true })
  public firstName: string;

  @Column({ nullable: true })
  public lastName: string;

  @Column({ nullable: true })
  public slackUserName: string;

  @Column({ nullable: true })
  public avatar24: string;

  @ManyToOne((type) => Team, (team) => team.users)
  public team: Team;

  @OneToMany((type) => Item, (item) => item.user)
  public items: Item[];

  public fullName(): string {
    if (this.firstName) {
      return `${this.firstName} ${this.lastName}`;
    } else {
      return this.slackUserName;
    }
  }

}
