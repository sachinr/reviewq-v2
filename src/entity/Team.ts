import {Column, Entity, JoinTable, OneToMany, PrimaryGeneratedColumn} from "typeorm";
import {User} from "./User";

@Entity()
export class Team {

  @PrimaryGeneratedColumn()
  public id: number;

  @Column()
  public name: string;

  @Column({ nullable: true })
  public slackId: string;

  @Column({ unique: true })
  public botSlackId: string;

  @Column({ unique: true })
  public botToken: string;

  @OneToMany((type) => User, (user) => user.team)
  public users: User[];
}
