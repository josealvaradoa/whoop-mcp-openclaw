FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY src/ ./src/
RUN pnpm run build

FROM node:20-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod
COPY --from=builder /app/dist/ ./dist/
COPY whoop-mcp.config.example.json ./whoop-mcp.config.example.json
RUN mkdir -p data && chmod 700 data
EXPOSE 3000
CMD ["node", "dist/index.js"]
