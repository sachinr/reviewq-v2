// Prisma-backed InstallationStore for Bolt's OAuth. This is the v2 replacement
// for the classic OAuthController: on install Bolt hands us an Installation,
// which we persist as a Workspace (bot token encrypted at rest) plus the
// installer AppUser; on every subsequent event Bolt calls fetchInstallation to
// get the bot token back so it can build the per-request WebClient. Storing the
// token encrypted means fetchInstallation is where we decrypt.

import type { Installation, InstallationQuery, InstallationStore } from "@slack/bolt";
import type { PrismaClient } from "@prisma/client";
import type { TokenCipher } from "../crypto/tokenCipher";

export function createInstallationStore(
  prisma: PrismaClient,
  cipher: TokenCipher,
): InstallationStore {
  return {
    async storeInstallation(installation: Installation): Promise<void> {
      const teamId = installation.team?.id;
      if (!teamId) {
        // Org-wide installs key on enterprise id; we don't support them yet, so
        // fail loudly rather than silently drop the install.
        throw new Error("storeInstallation: missing team id (enterprise installs unsupported)");
      }
      const botToken = installation.bot?.token;
      const botUserId = installation.bot?.userId;
      if (!botToken || !botUserId) {
        throw new Error("storeInstallation: installation missing bot token/userId");
      }
      const scopes = (installation.bot?.scopes ?? []).join(",");

      const workspace = await prisma.workspace.upsert({
        where: { slackTeamId: teamId },
        create: {
          slackTeamId: teamId,
          slackEnterpriseId: installation.enterprise?.id ?? null,
          name: installation.team?.name ?? null,
          botUserId,
          botTokenEncrypted: cipher.encrypt(botToken),
          botScopes: scopes,
          isActive: true,
        },
        update: {
          slackEnterpriseId: installation.enterprise?.id ?? null,
          name: installation.team?.name ?? null,
          botUserId,
          botTokenEncrypted: cipher.encrypt(botToken),
          botScopes: scopes,
          isActive: true,
          uninstalledAt: null,
        },
      });

      const installerSlackId = installation.user?.id;
      if (installerSlackId) {
        await prisma.appUser.upsert({
          where: {
            workspaceId_slackUserId: {
              workspaceId: workspace.id,
              slackUserId: installerSlackId,
            },
          },
          create: {
            workspaceId: workspace.id,
            slackUserId: installerSlackId,
            isInstaller: true,
            userTokenEncrypted: installation.user?.token
              ? cipher.encrypt(installation.user.token)
              : null,
          },
          update: {
            isInstaller: true,
            ...(installation.user?.token
              ? { userTokenEncrypted: cipher.encrypt(installation.user.token) }
              : {}),
          },
        });
      }
    },

    async fetchInstallation(query: InstallationQuery<boolean>): Promise<Installation> {
      const workspace = await prisma.workspace.findUnique({
        where: { slackTeamId: query.teamId ?? "" },
      });
      if (!workspace || !workspace.isActive) {
        throw new Error(`fetchInstallation: no active install for team ${query.teamId}`);
      }
      return {
        team: { id: workspace.slackTeamId, name: workspace.name ?? undefined },
        enterprise: workspace.slackEnterpriseId
          ? { id: workspace.slackEnterpriseId }
          : undefined,
        bot: {
          token: cipher.decrypt(workspace.botTokenEncrypted),
          userId: workspace.botUserId,
          scopes: workspace.botScopes ? workspace.botScopes.split(",") : [],
          id: workspace.botUserId,
        },
        user: { id: "", token: undefined, scopes: undefined },
      } as Installation;
    },

    async deleteInstallation(query: InstallationQuery<boolean>): Promise<void> {
      await prisma.workspace.updateMany({
        where: { slackTeamId: query.teamId ?? "" },
        data: { isActive: false, uninstalledAt: new Date() },
      });
    },
  };
}
