import {Column, Entity, ManyToOne, PrimaryGeneratedColumn} from "typeorm";
import {User} from "./User";

@Entity()
export class Item {
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

  @Column()
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

  constructor(channelId: number, userId: number, ts: string, message: string) {
    this.channelId = channelId,
      this.userId = userId,
      this.ts = ts,
      this.message = message;

    this.archiveLink = this.buildArchiveLink();
  }

  private buildArchiveLink(): string {
    if (!this.archiveLink && this.ts) {
      const domain: string = "peeeps";
      const channelName: string = "general";

      return `https://${domain}.slack.com/archives/${channelName}/p${this.ts.replace(".", "")}`;
    } else {
      return this.archiveLink;
    }
  }
}
