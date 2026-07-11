# FeltSide engine — single container: Express serves the API, the socket
# layer, and the built client (review_url deep links land here).

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm ci
COPY client ./client
COPY server ./server
RUN npm run build --workspace=client

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
RUN npm ci --omit=dev --workspace=server && npm cache clean --force
COPY server ./server
COPY supabase ./supabase
COPY --from=build /app/client/dist ./client/dist

EXPOSE 3001
CMD ["node", "server/src/index.js"]
