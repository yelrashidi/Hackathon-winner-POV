# One image for the whole app: Next.js serves the pages (frontend) and runs src/server (backend).
# The same image also runs the one-shot `setup` service (migrations + first-time seed), which is
# why dev dependencies (tsx, drizzle) stay installed. Built and started by `docker compose up -d`.
FROM node:24-slim

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Dependencies first, so editing source does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Source, the dataset (read at runtime: users, payments seed, reference CSVs) and fixtures.
COPY . .
RUN npm run build

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
EXPOSE 3000
CMD ["npx", "next", "start"]
