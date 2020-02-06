import { Block, KnownBlock, PlainTextElement } from "@slack/types";
import { WebClient } from "@slack/web-api";
import nodeFetch from "node-fetch";
import { Channel } from "./Channel";
import { Item } from "./Item";

// tslint:disable: object-literal-sort-keys
export class View {
  private static PRIMARY_COLOR = "#9469df";
  private static SECONDARY_COLOR = "#dbaaaa";
  private static ERROR_COLOR = "#DD3E1C";
  private static PER_PAGE = 3;

  // tslint:disable: variable-name
  public blocks: Array<KnownBlock | Block>;
  public callback_id?: string;
  public clear_on_close?: boolean;
  public close?: PlainTextElement;
  public notify_on_close?: boolean;
  public private_metadata?: string;
  public submit?: PlainTextElement;
  public title?: PlainTextElement;
  public type?: "home" | "modal";

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
}
