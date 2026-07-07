# Multi-stage build. One image runs BOTH processes — the platform picks the role
# by overriding the command: `npm start` (web / Bolt HTTP receiver) or
# `npm run start:worker` (BullMQ notification worker). See Procfile / README.

# ---- build stage: install all deps, generate the Prisma client, compile TS ----
FROM node:22-bookworm-slim AS build
WORKDIR /app

# openssl is required by Prisma's query engine (missing from -slim by default).
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

# Copy manifest + schema first so `npm ci` (which runs `postinstall: prisma
# generate`) can find prisma/schema.prisma, and so this layer caches on deps.
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage: slim image with only what's needed to run ----------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

# node_modules carries the generated Prisma client and the `prisma` CLI used by
# the release step (`npm run migrate:deploy`).
COPY package*.json ./
COPY prisma ./prisma
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

USER node
EXPOSE 3000
# Default role is the web process; the worker overrides this with start:worker.
CMD ["npm", "start"]
