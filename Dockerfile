# Multi-stage build.
#
# Kept platform-neutral on purpose: this same image runs on Render, Railway,
# Fly.io, Koyeb or a plain VPS. Nothing in it is specific to one host.

# ----------------------------------------------------------------- build ----
FROM node:20-slim AS build

# Prisma's engines need OpenSSL, and it is not in -slim.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a source-only change does not reinstall them.
COPY package*.json ./
RUN npm ci

# The client is generated from the schema, so the schema has to be present
# before `npm run build` typechecks against it.
COPY prisma ./prisma
RUN npx prisma generate

# Both configs: the build one extends the root one, so copying only
# tsconfig.build.json fails with "the specified path does not exist".
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ------------------------------------------------------------------ run ----
FROM node:20-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# The generated client and the migrations both ship: `migrate deploy` runs at
# start-up, so a deploy that adds a column does not need a separate step.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/dist ./dist
COPY prisma ./prisma

# Do not run as root.
USER node

# The platform injects PORT; 4000 is only the local default.
ENV PORT=4000
EXPOSE 4000

# Migrations before the server, in one command, so a container that starts is a
# container whose schema matches its code.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
