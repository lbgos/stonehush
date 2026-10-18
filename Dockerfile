FROM node:24.18.0-bookworm@sha256:4e9cb555d708e0829c9d93e5eeae9dfab0617b832ca436a690680e0fca735ef5 AS build
RUN corepack enable && corepack prepare pnpm@10.24.0 --activate
WORKDIR /source
COPY . .
RUN test "$(node --version)" = v24.18.0 && test "$(pnpm --version)" = 10.24.0 \
    && pnpm install --frozen-lockfile
RUN pnpm --filter @stonehush/api... run build \
    && pnpm --filter @stonehush/web... run build \
    && pnpm --filter @stonehush/api deploy --legacy --prod /package/api
RUN mkdir /package/web && cp -R apps/web/dist/. /package/web/ \
    && cp LICENSE /package/LICENSE
ARG SOURCE_REVISION
ARG SOURCE_TREE
RUN node scripts/verify-control-plane.mjs /package "$SOURCE_REVISION" "$SOURCE_TREE"

FROM node:24.18.0-bookworm-slim@sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6 AS runtime
ARG SOURCE_REVISION
ARG SOURCE_TREE
LABEL org.opencontainers.image.title="Stonehush control plane" \
      org.opencontainers.image.source="https://github.com/lbgos/stonehush" \
      org.opencontainers.image.revision="$SOURCE_REVISION" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      dev.stonehush.source-tree="$SOURCE_TREE"
WORKDIR /opt/stonehush
COPY --from=build /package/ ./
COPY --chmod=755 packaging/stonehush /usr/local/bin/stonehush
COPY --chmod=755 packaging/control-plane /usr/local/bin/stonehush-control-plane
RUN mkdir /data && chown 10001:10001 /data && chmod 0700 /data
ENV NODE_ENV=production STONEHUSH_DATA_DIR=/data STONEHUSH_WEB_DIR=/opt/stonehush/web STONEHUSH_API_PORT=8787
USER 10001:10001
ENTRYPOINT ["stonehush-control-plane"]
