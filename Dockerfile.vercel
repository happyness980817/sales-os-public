# React Router and the official ChatKit Python API share one deployed app.
FROM node:24-bookworm-slim AS web-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY app ./app
COPY public ./public
COPY react-router.config.ts vite.config.ts tsconfig.json ./
ARG SALESOS_PUBLIC_URL=http://localhost:3000
RUN SALESOS_PUBLIC_URL="$SALESOS_PUBLIC_URL" npm run build
RUN npm prune --omit=dev --no-audit --no-fund

FROM ghcr.io/astral-sh/uv:0.13.8 AS uv-tool
FROM python:3.12-slim-bookworm AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 tini && rm -rf /var/lib/apt/lists/*
COPY --from=uv-tool /uv /usr/local/bin/uv
COPY --from=web-build /usr/local/bin/node /usr/local/bin/node
COPY --from=web-build /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    SALESOS_API_ORIGIN=http://127.0.0.1:8000 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy
COPY services/api/pyproject.toml services/api/uv.lock ./services/api/
RUN cd services/api && uv sync --frozen --no-dev --no-install-project --no-cache
COPY services/api/salesos_api ./services/api/salesos_api
COPY --from=web-build /app/node_modules ./node_modules
COPY --from=web-build /app/build ./build
COPY --from=web-build /app/package.json ./package.json
RUN groupadd --system salesos && useradd --system --gid salesos --create-home salesos \
    && chown -R salesos:salesos /app
USER salesos
EXPOSE 3000
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["npm", "start"]
