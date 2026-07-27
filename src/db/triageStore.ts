// Prisma-backed TriageStore — the production adapter behind the triage job's
// persistence port. Both writes upsert on the item's unique itemId so re-triaging
// the same item (e.g. a re-added/reopened item) overwrites its previous summary /
// clarification rather than failing on the unique constraint or piling up rows.

import type { PrismaClient } from "@prisma/client";
import type { TriageStore } from "../jobs/triageQueue";

export function createPrismaTriageStore(prisma: PrismaClient): TriageStore {
  return {
    async saveSummary(itemId: string, summary: string, model: string): Promise<void> {
      await prisma.itemSummary.upsert({
        where: { itemId },
        create: { itemId, summary, model },
        update: { summary, model },
      });
    },

    async saveClarification(itemId: string, question: string, model: string): Promise<void> {
      await prisma.itemClarificationRequest.upsert({
        where: { itemId },
        // Re-asking resets the request to open — the previous question may have
        // been resolved/dismissed against stale content.
        create: { itemId, question, model, status: "open" },
        update: { question, model, status: "open" },
      });
    },
  };
}
