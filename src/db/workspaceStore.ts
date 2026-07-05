// Prisma-backed WorkspaceStore — the production adapter behind the resolver's
// persistence port. Upserts are keyed on the natural Slack composite keys
// (workspaceId + slackChannelId / slackUserId) that the schema marks @@unique,
// so a repeated event is idempotent and only refreshes the mutable fields.

import type { AppUser, Channel, PrismaClient, Workspace } from "@prisma/client";
import type {
  UpsertChannelInput,
  UpsertUserInput,
  WorkspaceStore,
} from "../slack/resolver";

export function createPrismaWorkspaceStore(prisma: PrismaClient): WorkspaceStore {
  return {
    findWorkspaceByTeamId(slackTeamId: string): Promise<Workspace | null> {
      return prisma.workspace.findUnique({ where: { slackTeamId } });
    },

    upsertChannel(input: UpsertChannelInput): Promise<Channel> {
      return prisma.channel.upsert({
        where: {
          workspaceId_slackChannelId: {
            workspaceId: input.workspaceId,
            slackChannelId: input.slackChannelId,
          },
        },
        create: {
          workspaceId: input.workspaceId,
          slackChannelId: input.slackChannelId,
          name: input.name ?? null,
          type: input.type,
          isBotMember: input.isBotMember,
          isPrivate: input.isPrivate,
        },
        update: {
          name: input.name ?? null,
          type: input.type,
          isBotMember: input.isBotMember,
          isPrivate: input.isPrivate,
        },
      });
    },

    upsertUser(input: UpsertUserInput): Promise<AppUser> {
      // Only overwrite profile fields when we actually have a value, so a lookup
      // that came back empty doesn't wipe a previously-hydrated display name.
      const profile: { displayName?: string; avatarUrl?: string } = {};
      if (input.displayName) profile.displayName = input.displayName;
      if (input.avatarUrl) profile.avatarUrl = input.avatarUrl;

      return prisma.appUser.upsert({
        where: {
          workspaceId_slackUserId: {
            workspaceId: input.workspaceId,
            slackUserId: input.slackUserId,
          },
        },
        create: {
          workspaceId: input.workspaceId,
          slackUserId: input.slackUserId,
          displayName: input.displayName ?? null,
          avatarUrl: input.avatarUrl ?? null,
        },
        update: profile,
      });
    },
  };
}
