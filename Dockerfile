FROM node:26-alpine

ENV CI=true
ENV NODE_ENV=production

RUN mkdir -p /home/node/app && chown -R node:node /home/node/app

WORKDIR /home/node/app

RUN npm install -g pnpm

USER node

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN pnpm install --frozen-lockfile

COPY --chown=node:node . .

RUN pnpm run build

EXPOSE 3010

CMD ["node", "dist/index.js"]