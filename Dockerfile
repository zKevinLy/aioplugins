
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY public ./public

RUN npm run build


FROM node:22-alpine AS production

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=7000
ENV DATA_DIR=/app/persist

RUN mkdir -p /app/persist \
    && chown -R node:node /app/persist

COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/public ./public

USER node

EXPOSE 7000

CMD ["node", "dist/index.js"]
