# Build stage
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY . .
ARG VITE_BASE=/
RUN VITE_BASE=$VITE_BASE npm run build

# Runtime stage
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4848
COPY --from=build /app/server ./server
COPY --from=build /app/dist ./dist
EXPOSE 4848
USER node
CMD ["node", "server/server.mjs"]