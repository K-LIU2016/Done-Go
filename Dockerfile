FROM node:22.22.2-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production TANGO_BIND=0.0.0.0 TANGO_DEMO_MODE=0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY web/ ./web/
COPY scripts/serve-tango.mjs scripts/tango-speech.mjs scripts/tango-speech.ps1 scripts/ai-assistant.mjs scripts/ai-discovery.mjs scripts/assistant-config.mjs scripts/collaboration-store.mjs scripts/collaboration-service.mjs scripts/production-readiness.mjs ./scripts/
COPY server/auth/ ./server/auth/
COPY server/urlguard.mjs ./server/
RUN mkdir -p /app/.tango-donego && chown node:node /app/.tango-donego
VOLUME ["/app/.tango-donego"]
USER node
EXPOSE 5207
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD node -e "fetch('http://127.0.0.1:5207/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/serve-tango.mjs"]
