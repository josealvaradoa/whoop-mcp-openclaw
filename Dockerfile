FROM node:20-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod
COPY dist/ ./dist/
COPY whoop-mcp.config.example.json ./whoop-mcp.config.example.json
RUN mkdir -p data && chmod 700 data
EXPOSE 3000
CMD ["node", "dist/index.js"]
