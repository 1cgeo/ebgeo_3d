# CLAUDE.md - EBGeo 3D

## O que é

Microsserviço de modelos tridimensionais do EBGeo. Converte os modelos
fotogramétricos da DGEO para 3D Tiles 1.1 (glTF binário com Draco e KTX2/ETC1S) e
serve cada modelo a partir de um único SQLite. Consumido pelo `../ebgeo_web`.

Irmão do `../ebgeo_360`. Quando algo aqui estiver ambíguo, o desenho de lá é a
referência: ele já opera 65 GB em SQLite em produção.

**Versão**: 1.0.0

## Stack

- Node.js >= 22, Fastify 5
- better-sqlite3 12 (API síncrona)
- glTF-Transform 4 mais draco3dgltf, sharp
- KTX-Software 4.4+ (`ktx`), executável externo, usado **só pela importação**

### Dependências nativas

`better-sqlite3` e `sharp` trazem binário pronto, mas só para a versão de Node
correspondente. **Mantenha `better-sqlite3` em 12.x ou mais novo**: a 11.x não tem
binário para Node 24 e cai para compilar do zero, o que falha em qualquer Windows
sem o Visual C++ Build Tools. Se o `npm install` começar a chamar
`node-gyp rebuild`, esse é o sintoma: suba a dependência, não instale compilador.

## Comandos

```bash
npm start                # servidor (porta 8082)
npm run dev              # com --watch
npm test                 # 21 testes (node:test)
npm run lint
npm run knip

node scripts/importar.js --origem <dir> --id <slug> [--nome "..."] \
                         [--workers 12] [--qlevel 200] [--limite N] \
                         [--forcar] [--dry-run]
node scripts/importar.js --promover --id <slug>   # termina uma importacao travada
node scripts/verificar.js --id <slug> [--origem <dir>]
node scripts/catalogo.js [--js --base /ebgeo_3d]
node scripts/cleanup-wal.js [--dry-run]
```

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
│   ├── queries.js       # prepared statements do catalogo
│   └── tiles-queries.js # le o BLOB, detecta troca de arquivo por mtime+size
├── middleware/cache.js
└── routes/
    ├── health.js
    ├── models.js        # catalogo, no formato do config.tilesets
    └── tiles.js         # curinga: tileset.json e cada tile

scripts/
├── importar.js          # os sete passos, com conferencia em cada um
├── converter-worker.js  # worker thread de conversao
├── verificar.js         # confere um modelo publicado
├── catalogo.js
├── cleanup-wal.js
└── lib/{b3dm,ktx2,conversor,tileset}.js
```

## Documentação

- `docs/formato.md`: o padrão e a medida que sustenta cada escolha
- `docs/operacao.md`: runbook da importação
- `docs/api.md`: contrato das rotas

## O que não mudar sem medir de novo

Cada item abaixo tem número atrás. Trocar sem refazer a medida desfaz uma decisão
que custou trabalho.

- **`page_size = 4096`** no banco de modelo. O 360 usa 65536 e está certo lá,
  porque o BLOB dele é uma foto de megabytes. Aqui o tile médio tem 39,9 KiB e
  64 KB desperdiça 21,9% de disco sem ganho de leitura.
- **O lote da transação na carga.** Medido com 8.000 blobs de 40 KiB: lote de 1
  contra lote de 256 dá **24x**; `synchronous` FULL contra OFF dá 2x;
  `journal_mode` e `cache_size` não dão nada. O que decide é o `LOTE_ESCRITA` do
  `importar.js`, não o pragma.
- **`journal_mode = MEMORY` na carga, e não `OFF`.** O SQLite **recusa** o OFF
  aqui e devolve `delete` sem reclamar, então pedir OFF dava a impressão de uma
  otimização que nunca aconteceu. O teste confere o valor efetivo.
- **`DELETE` no fecho.** Em WAL o SQLite cria o `-shm` ao abrir, e num volume
  `:ro` isso derruba o serviço com erro que não aponta a causa.
- **Draco, e não meshopt.** Empatam no Cesium com carga paralela. O meshopt custa
  17% a mais de bytes. Uma medida em série dava meshopt 2,5 vezes mais rápido, e
  era artefato do agendamento por quadro do worker de Draco.
- **ETC1S qlevel 200.** É o joelho da curva de PSNR. UASTC custa de 2,8 a 4 vezes
  o tamanho.
- **O token de geração na `uri`.** Sem ele o `immutable` de um ano faz o navegador
  compor tile velho na árvore nova depois de uma reimportação, sem erro nenhum.
- **A rota ignora o `?v=`.** Comparar com o token de hoje recusaria o pedido do
  cliente que ainda segura o `tileset.json` anterior.
- **O `sharp` antes do `ktx`.** O KTX-Software não lê WebP. Sem esse passo os 7
  modelos do DJI Terra saem 42% maiores, com a textura intacta e o Draco desfeito.
- **O `upAxis` da origem, propagado até o conversor.** Ver a primeira armadilha
  abaixo: apagar a declaração sem rotacionar a geometria deita o modelo.
- **A ordem textura, depois geometria.** Mexer na textura decodifica o documento e
  desfaz o Draco. Inverter entrega arquivo sem compressão de geometria, e o
  sintoma é `extensionsUsed` vazio, nunca um erro.

## Convenções

- **Comentário explica o porquê, não o quê.** Onde houver número medido, ele entra
  no comentário. Um comentário que só reconta a linha abaixo é ruído.
- **Português no código e na documentação**, sem acento em identificador. Acento
  correto na prosa.
- **Toda escrita se confere relendo o destino.** O retorno da função que escreveu
  é eco dela mesma, nunca prova. A conferência cobre a mesma extensão da escrita:
  gravou N tiles, procure os N.
- **Verificação que não pode falhar não é verificação.** A conferência do passo 5
  da importação só vale porque reprova de verdade: rode com `--limite` e ela
  acusa as referências quebradas.
- **Teste monta o app pelo `build-app.js`.** Montar um app à mão no teste já
  deixou rota de fora no `ebgeo_360`: passava nos testes e respondia 404 no
  serviço vivo.

## Armadilhas conhecidas

- **`asset.gltfUpAxis: "Z"` NÃO se apaga sem rotacionar a geometria.** O DJI
  Terra declara Z-up, e o conteúdo dele está mesmo em Z-up. O campo não existe no
  esquema de 1.1, e a conversão o remove. Removido sozinho, ele faz o Cesium ler
  o conteúdo como Y-up: **o modelo aparece de pé**. Aconteceu com o Silo Oreste
  Ceretta em 2026-08-22. Quem viu foi o chefe, na tela, depois de eu ter escrito
  na documentação que a remoção era segura. O `criarConversor` recebe `upAxis` e
  rotaciona (x fica, y recebe z, z recebe -y). O teste
  `conteudo Z-up e rotacionado` reprova a volta.
- **O ponto de navegação NÃO se preenche a mão.** O tileset do DJI Terra não
  publica `properties` nem `boundingVolume.region`, só `box`. Até 2026-08-22 o
  importador só lia as duas primeiras formas. Ele avisava "preencha a mão", e o
  operador chutava: o Silo Oreste Ceretta entrou **3.657 m ao sul** do lugar
  dele. Hoje o `envelopeGeodesico` mede a árvore inteira. Para modelo já
  importado, `node scripts/remedir.js` refaz a medida sem reconverter.
- **O box de um tile é LOCAL ao `transform` acumulado, nunca ECEF.** Ler o box
  direto põe o modelo perto de (0, 0), no golfo da Guiné. O `transform` mora no
  root do tileset EXTERNO, e não na raiz. Quem para na raiz não vê nenhum. O
  teste `envelopeGeodesico resolve o transform do tileset externo` reprova a
  volta, e a assertiva que pega é a latitude longe do equador.
- **Modelo que flutua é falta de terreno no cliente, e não defeito do modelo.**
  Um Cesium que não carrega o terreno cai EM SILÊNCIO para o
  `EllipsoidTerrainProvider`. O chão vira liso na altura 0, e todo modelo passa a
  flutuar a própria altura elipsoidal. O catálogo guarda essa altura medida em
  `ground_height` e publica `height_offset` 0. Para a máquina sem terreno,
  `node scripts/catalogo.js --js --sem-terreno` gera o config com
  `heightOffset = -ground_height`. NUNCA gere o config de produção com essa
  opção, e nunca ajuste a altura no olho.
- **Medir no navegador com `requestAnimationFrame` não funciona.** Numa aba que
  o Chrome considera `hidden` o rAF **não dispara nenhum quadro**, e o
  `setTimeout` cai para cerca de um por segundo. Foi assim que a mesma variante
  mediu 19,7 s e 83,6 s. O agendador que escapa é o `MessageChannel`: 107.599
  ticks por segundo na mesma aba oculta. A `bench/cesium.html` usa ele, chama
  `scene.render()` na mão e reprova a própria medida se a cadência passar de
  5 ms.
- **`Page.captureScreenshot` do CDP também estoura com a aba oculta.** O
  framebuffer do WebGL existe: `canvas.toDataURL` o lê, desde que o Viewer suba
  com `preserveDrawingBuffer: true`. A bancada faz POST da imagem para
  `bench/capturas/`. Contagem de tile diz quanto custou, e só a imagem diz se
  ficou bom.
- **`viewBoundingSphere` e `flyToBoundingSphere` AGENDAM o movimento.** Num laço
  de render manual a câmera nunca chega: medido, dão 3 tiles, 0 triângulo e tela
  preta. Use `camera.setView` com a posição calculada, e ortogonalize o `up`
  contra a `direction`, senão o Cesium gira a cena.
- **Windows segura o arquivo.** Reimportar com o serviço no ar falha com `EBUSY`:
  o `closeModelDb` só fecha a conexão do próprio processo, e o serviço é outro.
  No Linux o rename por cima funciona. O roteiro detecta, preserva o `.parcial` e
  manda usar `--promover` depois de parar o serviço.
- **Tile vazio existe.** No Ponte_Quatis são 5 em 7.501: sem malha e sem imagem,
  já assim na origem. Nenhuma régua pode exigir Draco deles.
- **A URI é relativa ao próprio `tileset.json`.** Um `Data/c00.glb` dentro de
  `Data/d000/tileset.json` aponta `Data/d000/Data/c00.glb`. Resolver contra a
  raiz dá chave inexistente, e a conferência acusa falso.
- **`asset.version: "0.0"`** aparece em 7 modelos do acervo (saída do DJI Terra).
  É inválido pelo esquema, e a conversão normaliza.
- **O glTF-Transform sobrescreve `asset.generator` na LEITURA.** Ler a
  proveniência pelo `Document` devolve "glTF-Transform v4.4.2" para todo modelo.
  O `leGerador` de `b3dm.js` lê do JSON cru, que é onde o valor sobrevive.
- **O `.env` só chega pelos atalhos do npm** (`--env-file-if-exists`). Chamando
  `node scripts/...` direto, `KTX_BIN` tem de vir do ambiente.
- **Em contêiner, a importação roda no mesmo serviço:**
  `docker compose run --rm ebgeo3d node scripts/importar.js --origem /origem/<pasta> --id <slug>`.
  Aponte `EBGEO3D_SOURCE_DIR` no `.env`, senão o compose monta `./origem`, que
  não existe.
