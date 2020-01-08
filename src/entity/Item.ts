import {Column, Entity, PrimaryGeneratedColumn} from "typeorm";

@Entity()
export class Item {
    @PrimaryGeneratedColumn()
    public id: number;

    @Column()
    public channelId: number;

    @Column()
    public userId: number;

    @Column()
    public ts: string;

    @Column()
    public message: string;

    @Column()
    public archiveLink: string;

    @Column({ default: false })
    public complete: boolean;

    @Column()
    public dateCompleted: number;

    @Column()
    public completedBy: string;

    @Column({ default: false })
    public vague: boolean;

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
