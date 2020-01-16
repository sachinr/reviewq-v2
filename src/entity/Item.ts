import { BaseEntity, Column, Entity, ManyToOne, PrimaryGeneratedColumn } from "typeorm";

import { Channel } from "./Channel";
import { Event } from "./Event";
import { User } from "./User";

@Entity()
export class Item extends BaseEntity {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ nullable: true })
  public channelId: number;

  @Column()
  public userId: number;

  @Column()
  public ts: string;

  @Column({ nullable: true })
  public message: string;

  @Column({ nullable: true })
  public archiveLink: string;

  @Column({ default: false })
  public complete: boolean;

  @Column({ nullable: true })
  public dateCompleted: number;

  @Column({ nullable: true })
  public completedBy: string;

  @Column({ default: false })
  public vague: boolean;

  @ManyToOne((type) => User, (user) => user.items)
  public user: User;

  @ManyToOne((type) => Channel, (channel) => channel.items)
  public channel: Channel;

  public createFromEvent(event: Event) {
    const item = new Item();

  }

}
