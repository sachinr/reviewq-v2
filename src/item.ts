class Item {
    public channelId: number;
    public userId: number;
    public ts: string;
    public message: string;
    public archiveLink: string;
    public complete: boolean;
    public dateCompleted: number;
    public completedBy: string;
    public vague: boolean;

    constructor(channelId: number, userId: number, ts: string, message: string) {
        this.channelId = channelId,
        this.userId = userId,
        this.ts = ts,
        this.message = message;

        this.archiveLink = this.buildArchiveLink();
    }

    private buildArchiveLink(): string {
      if (!this.archiveLink) {
        const domain: string = "peeeps";
        const channelName: string = "general";

        return `https://${domain}.slack.com/archives/${channelName}/p${this.ts.replace(".", "")}`;
      } else {
        return this.archiveLink;
      }
    }
}
export = Item;
