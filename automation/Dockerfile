# Node 24 runs TypeScript directly (type stripping), so there is no build step.
FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
USER node
CMD ["node", "src/index.ts"]
