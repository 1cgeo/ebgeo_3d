FROM node:22-alpine AS base

# Dependencias nativas:
#   python3, make, g++  -> better-sqlite3 e sharp, se o prebuilt nao servir
#   vips-dev            -> sharp
#   ktx-tools           -> o `ktx` do KTX-Software, usado SO pela importacao
#
# O `ktx` entra na imagem mesmo nao sendo usado pelo servico porque a importacao
# roda por `docker compose run` neste mesmo container. Deixar de fora obrigaria a
# manter uma segunda imagem so para converter.
RUN apk add --no-cache python3 make g++ vips-dev ktx-tools

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY scripts/ ./scripts/

RUN mkdir -p /data/models /data/assets

ENV NODE_ENV=production
ENV PORT=8082
ENV EBGEO3D_DATA_DIR=/data
ENV KTX_BIN=ktx

# TETO DE HEAP, casado com o `memory: 512M` do docker-compose.yml. Sem ele o V8
# so coleta sob pressao propria, ignora o limite do cgroup e o container morre
# por OOM em vez de coletar. Ver a mesma linha no Dockerfile do ebgeo_360.
#
# 320 MB deixa espaco para o que NAO e heap do V8 neste servico: o mmap dos
# bancos abertos (12 x 64 MB de endereco virtual, com so a pagina quente
# residente) e o cache de pagina do SQLite (12 x 8 MB).
ENV NODE_OPTIONS=--max-old-space-size=320

EXPOSE 8082

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -qO- http://localhost:8082/health || exit 1

CMD ["node", "src/server.js"]
