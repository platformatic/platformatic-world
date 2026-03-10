FROM node:24-slim

RUN npm install -g pnpm@10

WORKDIR /app

COPY package.json ./
RUN pnpm install --prod

COPY watt.json ./
COPY plugins/ ./plugins/
COPY lib/ ./lib/
COPY queue/ ./queue/
COPY migrations/ ./migrations/

EXPOSE 3042

ENV PORT=3042
ENV HOST=0.0.0.0

CMD ["npx", "wattpm", "start"]
