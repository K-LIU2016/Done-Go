FROM node:22.22.2-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production TANGO_BIND=0.0.0.0
COPY package.json ./
COPY web/index.html web/privacy.js web/agreements.js web/speech-capture.js web/assistant-core.js web/assistant-ui.js web/assistant.css ./web/
COPY scripts/serve-tango.mjs scripts/tango-speech.mjs scripts/tango-speech.ps1 scripts/ai-assistant.mjs scripts/ai-discovery.mjs scripts/assistant-config.mjs ./scripts/
USER node
EXPOSE 5207
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD node -e "fetch('http://127.0.0.1:5207/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/serve-tango.mjs"]
