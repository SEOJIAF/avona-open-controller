# open-avona web app. No npm dependencies, so the image is just Node plus the app files.
FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

WORKDIR /app
COPY --chown=node:node package.json *.mjs ./
COPY --chown=node:node public ./public

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "healthcheck.mjs"]

CMD ["node", "server.mjs"]
