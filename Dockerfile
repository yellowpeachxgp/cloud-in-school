FROM node:22-alpine AS runtime
WORKDIR /app

RUN addgroup -S discloud && adduser -S discloud -G discloud

COPY package.json ./
COPY contracts ./contracts
COPY packages ./packages
COPY apps ./apps
COPY examples ./examples
COPY tools ./tools
COPY SYSTEM_CONTRACT.md THIRD_PARTY_NOTICES.md ./
COPY licenses ./licenses
COPY docs ./docs

USER discloud
EXPOSE 8080 8081
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "apps/api/src/main.mjs"]
