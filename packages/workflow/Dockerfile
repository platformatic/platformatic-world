FROM node:24-slim

RUN npm install -g pnpm@10

WORKDIR /app

COPY package.json tsconfig.json ./
RUN pnpm install

COPY watt.json ./
COPY plugins/ ./plugins/
COPY lib/ ./lib/
COPY queue/ ./queue/
COPY migrations/ ./migrations/

# Compile TypeScript plugins to dist/, then remove devDependencies
RUN pnpm run build
RUN pnpm prune --prod

EXPOSE 3042

ENV PORT=3042
ENV HOST=0.0.0.0

CMD ["npx", "wattpm", "start"]
