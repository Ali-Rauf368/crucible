FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci -w apps/api --include-workspace-root=false --omit=dev --ignore-scripts && npm i -w apps/api tsx --no-save --ignore-scripts
COPY apps/api apps/api
WORKDIR /app/apps/api
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4200
EXPOSE 4200
USER node
CMD ["npx", "tsx", "src/server.ts"]
