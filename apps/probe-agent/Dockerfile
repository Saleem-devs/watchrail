FROM node:24-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/probe-agent ./apps/probe-agent
RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm build:packages && pnpm --filter @watchrail/probe-agent build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/probe-agent ./apps/probe-agent
CMD ["node", "apps/probe-agent/dist/main.js"]
