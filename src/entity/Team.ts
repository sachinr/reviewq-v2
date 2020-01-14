import {BaseEntity, Column, Entity, OneToMany, PrimaryGeneratedColumn} from "typeorm";
import {Channel} from "./Channel";
import {User} from "./User";

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

  @Column()
  public scope: string;

  @Column({ unique: true })
  public botSlackId: string;

  @Column({ unique: true })
  public botToken: string;

  @OneToMany((type) => User, (user) => user.team)
  public users: User[];

  @OneToMany((type) => Channel, (channel) => channel.team)
  public channels: Channel[];
}
