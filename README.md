# EBGeo 3D

Microsserviço de modelos tridimensionais do EBGeo. Converte os modelos
fotogramétricos da DGEO para 3D Tiles 1.1 com textura KTX2 e geometria Draco, e
serve cada modelo a partir de um único arquivo SQLite.

Irmão do [`ebgeo_360`](../ebgeo_360), de quem herda o desenho: um `index.db`
central de catálogo, um banco por unidade servida, rotas com ETag e `immutable`,
e semáforo de concorrência.

Consumido pelo [`ebgeo_web`](../ebgeo_web).

## Por que existe

O acervo tem **115 modelos, 2.261.536 arquivos e 96,8 GiB** numa árvore de
arquivos estática, com textura JPEG ou WebP e tile médio de 44,2 KiB. Dois
problemas medidos:

- **Memória de vídeo.** Uma vista de 110 m sobre um dos modelos menores pede
  **1,4 GiB de VRAM só de textura**. Depois da conversão, 206 MiB. O JPEG
  descomprime para RGBA8 na placa; o KTX2 fica em BC1.
- **Número de arquivos.** Backup, cópia para produção e varredura de antivírus
  são cobrados por arquivo, não por byte. O maior modelo tem 247.125 deles.

A conversão custa 8% de espaço em disco e cerca de 12,6 h de máquina para o
acervo inteiro.

Os números e o porquê de cada escolha estão em [docs/formato.md](docs/formato.md).
Onde a migração do acervo parou está em [docs/acervo.md](docs/acervo.md).

## Começar

```bash
npm install
cp .env.example .env          # aponte KTX_BIN para o ktx do KTX-Software
npm start                     # porta 8082
```

Importar um modelo:

```bash
node scripts/importar.js --origem "$EBGEO3D_SOURCE_DIR/Ponte_Quatis" \
  --id ponte-quatis --nome "Ponte General Osório (Quatis)" --workers 12
```

Ligar no `ebgeo_web`, em `src/js/config.js`:

```js
{ url: "/ebgeo_3d/api/v1/models/ponte-quatis/tileset.json", id: "ponte-quatis", ... }
```

Nada mais muda no cliente.

## Comandos

```bash
npm start          # servidor (node --env-file=.env src/server.js)
npm run dev        # com --watch
npm run importar   # atalho para scripts/importar.js
npm run catalogo   # imprime o catalogo pronto para o config.tilesets
npm run verificar  # confere um modelo importado contra a origem
#                    (importar.js --promover --id <slug> termina uma importacao
#                     cuja troca de arquivo travou; nao reconverte nada)
npm run cleanup-wal
npm test           # 21 testes (node:test)
npm run lint
npm run knip       # codigo morto e dependencia nao usada

npm run bench      # bancada da camada SQLite (com --expose-gc)
npm run bench:http # bancada de carga pela porta HTTP
```

O serviço **não** serve o diretório `assets/`. Miniatura e vídeo de prévia saem
por outro caminho, e os campos `preview_thumb` e `preview_video` guardam a URL
pronta.

## Estrutura

```
src/
├── server.js            # entrada, encerramento gracioso
├── build-app.js         # monta o Fastify sem escutar (o teste usa este)
├── config.js
├── db/
│   ├── connection.js    # index.db mais LRU de bancos de modelo
│   ├── schema.sql       # catalogo
│   ├── model-schema.sql # {slug}.3dtiles
│   ├── queries.js
│   └── tiles-queries.js # le o BLOB, detecta troca de arquivo
├── middleware/cache.js
└── routes/
    ├── health.js
    ├── models.js        # catalogo
    └── tiles.js         # curinga: tileset.json e cada tile

scripts/
├── importar.js          # os sete passos, com conferencia em cada um
├── converter-worker.js  # worker de conversao
├── verificar.js
├── catalogo.js
├── cleanup-wal.js
└── lib/
    ├── b3dm.js          # envelope do 3D Tiles 1.0
    ├── ktx2.js          # textura para KTX2/ETC1S
    ├── conversor.js     # o tile inteiro
    ├── copia.js         # copiar do HD externo, e CONFERIR que tudo chegou
    └── tileset.js       # reescrita do tileset.json

docs/
├── formato.md     # o padrao e a medida de cada escolha
├── operacao.md    # runbook da importacao
├── api.md         # contrato das rotas
├── acervo.md      # onde a migracao parou, e o que falta
└── desempenho.md  # as bancadas, o que ja mediram, e o que medir agora

bench/
├── http.js       # carga pela porta HTTP, com percentis
├── banco.js      # camada SQLite isolada, pragmas em A/B
└── lib/          # alvos (travessia do tileset) e gerador de carga
```

## Dependências nativas

`better-sqlite3` e `sharp` são addons nativos e trazem binário pronto, mas só
para a versão de Node correspondente. Mantenha `better-sqlite3` em 12.x ou mais
novo: a 11.x não tem binário para Node 24 e cai para compilar do zero, o que
falha em qualquer Windows sem o Visual C++ Build Tools. Se o `npm install` começar
a chamar `node-gyp rebuild`, esse é o sintoma.

O `ktx` do KTX-Software é um executável externo, usado **só pela importação**. O
serviço não precisa dele.

## Stack

- Node.js >= 22, Fastify 5
- better-sqlite3 12 (API síncrona)
- glTF-Transform 4 mais draco3dgltf, para a conversão
- sharp, para decodificar a textura de origem antes do KTX2
- KTX-Software 4.4+ (`ktx`), para o ETC1S
