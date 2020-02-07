import { WebAPICallResult, WebClient } from "@slack/web-api";
import { BaseEntity, Column, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn } from "typeorm";

import {Item} from "./Item";
import {Team} from "./Team";

interface IUsersInfoCallResult extends WebAPICallResult {
  user: {
    id: string;
    team_id: string;
    name: string;
    deleted: boolean;
    real_name: string;
    tz: string;
    tz_label: string;
    tz_offset: number;
    profile: {
      real_name: string;
      display_name: string;
      first_name: string;
      last_name: string;
      image_24: string;
      image_72: string;
    };
    is_admin: boolean;
    is_owner: boolean;
    is_primary_owner: boolean;
    is_restricted: boolean;
    is_ultra_restricted: boolean;
    is_bot: boolean;
    is_app_user: boolean;
    updated: number;
  };
}

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
  public displayName: string;

  @Column({ nullable: true })
  public realName: string;

  @Column({ nullable: true })
  public avatar24: string;

  @Column({ default: false })
  public installer: boolean;

  @Column({ default: false })
  public isAdmin: boolean;

  @Column({ default: false })
  public isOwner: boolean;

  @Column({ default: false })
  public isPrimaryOwner: boolean;

  @Column({ default: false })
  public isRestricted: boolean;

  @Column({ default: false })
  public isUltraRestricted: boolean;

  @Column({ nullable: true })
  public token: string;

  @Column({ nullable: true })
  public scope: string;

  @ManyToOne((type) => Team, (team) => team.users)
  public team: Team;

  @OneToMany((type) => Item, (item) => item.user)
  public items: Item[];

  @OneToMany((type) => Item, (item) => item.completedBy)
  public completedItems: Item[];

  public fullName(): string {
    if (this.firstName) {
      return `${this.firstName} ${this.lastName}`;
    } else {
      return this.displayName || this.realName || "Unknown user";
    }
  }

  public async fetchProfile() {
    const client = new WebClient(this.team.botToken);
    const result = await client.users.info({
      user: this.slackId,
    }) as IUsersInfoCallResult;

    if (result.ok) {
      const resUser = result.user;
      this.isAdmin = resUser.is_admin;
      this.isOwner = resUser.is_owner;
      this.isPrimaryOwner = resUser.is_primary_owner;
      this.isRestricted = resUser.is_restricted;
      this.isUltraRestricted = resUser.is_ultra_restricted;
      this.firstName = resUser.profile.first_name;
      this.lastName = resUser.profile.last_name;
      this.avatar24 = resUser.profile.image_24;
      this.displayName = resUser.profile.display_name;
      this.realName = resUser.profile.real_name;
    }
  }

}
