import { ActionsBlock, Block, Button, ContextBlock, DividerBlock, KnownBlock, PlainTextElement, SectionBlock } from "@slack/types";
import { WebClient } from "@slack/web-api";

import { Channel } from "./Channel";
import { ISlackFile } from "./Event";
import { Item } from "./Item";
import { ICompleteButton, IPaginationButton, IPaginationInfo } from "./Message";

// tslint:disable: object-literal-sort-keys
export class View {
  private static PRIMARY_COLOR = "#9469df";
  private static SECONDARY_COLOR = "#dbaaaa";
  private static ERROR_COLOR = "#DD3E1C";
  private static PER_PAGE = 3;

  // tslint:disable: variable-name
  public blocks: Array<KnownBlock | Block>;
  public callback_id?: string;
  public block_id?: string;
  public clear_on_close?: boolean;
  public close?: PlainTextElement;
  public notify_on_close?: boolean;
  public private_metadata?: string;
  public submit?: PlainTextElement;
  public title?: PlainTextElement;
  public type: "home" | "modal";

  public channel: Channel;

  constructor(channel: Channel, options?: object) {
    this.channel = channel;
    this.blocks = [];
    if (options) {
      Object.assign(this, options);
    }
  }

  public async addNewItemForm() {
    this.blocks = [
      {
        type: "input",
        element: {
          type: "plain_text_input",
          multiline: true,
        },
        label: {
          type: "plain_text",
          text: "Quick add",
          emoji: true,
        },
      },
      {
        type: "divider",
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Tip:* You can use the 'Add to Queue' message action on any message to add it to the channel's queue.",
        },
      },
      {
        type: "image",
        title: {
          type: "plain_text",
          text: "How to add existing messages",
          emoji: true,
        },
        image_url: "http://reviewq.sachinr.com:4444/message-action-screenshot.png",
        alt_text: "Example Image",
      }];
    this.callback_id = "new_item";
    this.submit = {
      type: "plain_text",
      text: "Submit",
      emoji: true,
    };
    this.title = {
      text: "New item",
      type: "plain_text",
      emoji: true,
    };
    this.type = "modal";

    return this;
  }

  public async buildItemBlocks(items: Item[], start: number, reverse: boolean, summaryText?: string) {
    const paginationInfo = await this.getPaginationInfo(items, start, reverse);

    this.blocks = [{
      type: "section",
      text: {
        type: "mrkdwn",
        text: summaryText,
      },
    } as SectionBlock,
    {
      type: "divider",
    } as DividerBlock,
    ];

    for (const currentItem of paginationInfo.currentPageItems) {
      let contextString = `*${currentItem.user.fullName()}* | `;
      contextString = contextString + `<!date^${currentItem.ts.split(".")[0]}^{date} at {time}^${currentItem.archiveLink}|Archive Link>`;

      const accButton = {
        type: "button",
        text: {
          type: "plain_text",
          text: ":white_check_mark: Complete",
          emoji: true,
        },
        action_id: JSON.stringify({ itemId: currentItem.id, itemTs: currentItem.ts,
          start, reverse } as ICompleteButton),
        value: "complete_item",
      } as Button;

      if (currentItem.complete) {
        accButton.action_id = JSON.stringify({ itemId: currentItem.id, itemTs: currentItem.ts,
          start, reverse } as ICompleteButton);
        contextString = contextString + ` | Completed by <@${currentItem.completedBy.slackId}>`;
        accButton.text.text = ":arrow_right_hook: Undo";
        accButton.value = "undo";
      }

      const itemBlocks: Block[] = [
        {
          type: "context",
          elements: [
            {
              type: "image",
              image_url: currentItem.user.avatar24,
              alt_text: currentItem.user.fullName(),
            },
            {
              type: "mrkdwn",
              text: contextString,
            },
          ],
        } as ContextBlock,
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: currentItem.message || "`No message text`",
          },
          accessory: accButton,
        } as SectionBlock,
      ];

      if (currentItem.filesJSON) {
        const files: ISlackFile[] = JSON.parse(currentItem.filesJSON);
        let fileString = "*Files:*\n";

        for (const file of files) {
          fileString = fileString + `<${file.permalink}|${file.name || file.title}>\n`;
        }

        itemBlocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: fileString,
          },
        } as SectionBlock);
      }

      itemBlocks.push({
        type: "divider",
      } as DividerBlock);

      this.blocks = this.blocks.concat(itemBlocks);
    }

    if (paginationInfo.totalItems > 0) {
      this.addPaginationButtons(paginationInfo);
    }

    return this;
  }

  public async open(trigger_id: string) {
    const args = Object.assign({}, this);
    delete args.channel;
    const client = new WebClient(this.channel.team.botToken);
    try {
      const result = await client.views.open({
        trigger_id,
        view: args,
      });

      return result;
    } catch (err) {
      // tslint:disable-next-line: no-console
      console.log(err.data.response_metadata);
    }
  }

  public async publish(userSlackId: string) {
    const args = Object.assign({}, this);
    delete args.channel;
    args.type = "home";
    const client = new WebClient(this.channel.team.botToken);
    try {
      const result = await client.views.publish({
        view: args,
        user_id: userSlackId,
      });

      return result;
    } catch (err) {
      // tslint:disable-next-line: no-console
      console.log(err.data.response_metadata);
    }
  }

  private async getPaginationInfo(items: Item[], start: number, reverse: boolean) {
    const totalItems = items.length;
    const totalPages = totalItems > 0 ? Math.ceil(totalItems / View.PER_PAGE) : 1;
    const currentPage = Math.ceil(start / View.PER_PAGE);
    let currentPageItems: Item[] = [];

    let end = start + (View.PER_PAGE - 1);
    if (end > totalItems) {
      end = totalItems;
    }

    if (totalItems > 0) {
      currentPageItems = items.slice(start - 1, end);
    }

    return {
      items,
      currentPage,
      currentPageItems,
      end,
      start,
      totalItems,
      totalPages,
      reverse,
    } as IPaginationInfo;
  }

  private addPaginationButtons(pagination: IPaginationInfo) {
    const buttons: IPaginationButton[] = [];
    if (pagination.end < pagination.totalItems) {
      buttons.push({text: "Next", start: pagination.end + 1, reverse: pagination.reverse});
    }
    if (pagination.start > View.PER_PAGE) {
      buttons.push({text: "Previous", start: pagination.start - View.PER_PAGE, reverse: pagination.reverse});
    }
    buttons.push({ text: "Minimize", start: -1, reverse: pagination.reverse });
    if (pagination.start === 1 && pagination.totalItems > 1) {
      buttons.push({ text: "Sort", start: 1, reverse: !pagination.reverse });
    }

    const elements: Button[]  = [];
    buttons.forEach((button) => {
      elements.push({
        type: "button",
        text: {
          type: "plain_text",
          text: button.text,
          emoji: true,
        },
        action_id: JSON.stringify(button),
        value: "pagination",
      } as Button);
    });

    this.blocks.push({
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: `Page ${pagination.currentPage} of ${pagination.totalPages}`,
      }],
    } as ContextBlock);

    this.blocks.push({
      type: "actions",
      elements,
    } as ActionsBlock);
  }
}
