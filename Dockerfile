FROM node:22-alpine

# Der Collector nutzt ausschliesslich Node-Builtins (fs, path) + globales fetch.
# Kein npm install, kein package.json noetig.
WORKDIR /app
COPY index.js ./

# Als non-root laufen (User 'node', uid 1000, existiert im Image).
# Das gemountete Ziel-Verzeichnis muss daher uid 1000 gehoeren (siehe compose-Kommentar).
USER node

# Defaults – im compose ueberschrieben.
ENV RPC=http://127.0.0.1:8545 \
    OUT=/data/traces \
    CAP=5 \
    POLL_MS=12000 \
    MAX_LAG=100 \
    TRACE_TIMEOUT=60s \
    INCLUDE_RECEIPTS=true \
    PROM_FILE=""

CMD ["node", "index.js"]
