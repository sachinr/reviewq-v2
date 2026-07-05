// A single shared PrismaClient. Instantiating more than one per process opens
// redundant connection pools, so both the web app and the worker import this.

import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();
