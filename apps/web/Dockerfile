FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/web --include-workspace-root=false --ignore-scripts
COPY apps/web apps/web
ARG NEXT_PUBLIC_API_URL=http://localhost:4200
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL API_URL=http://api:4200
RUN npm -w apps/web run build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production API_URL=http://api:4200
EXPOSE 3200
USER node
CMD ["npm", "-w", "apps/web", "run", "start"]
