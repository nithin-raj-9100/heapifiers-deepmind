# Parley — build stage compiles TypeScript, runtime stage ships only what the server needs.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY server ./server
COPY tests ./tests
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY public ./public
EXPOSE 8080
ENV PORT=8080
CMD ["node", "dist/server/index.js"]
