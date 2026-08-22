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

- `docs/formato.md` — o padrão e a medida que sustenta cada escolha
- `docs/operacao.md` — runbook da importação
- `docs/api.md` — contrato das rotas

## O que não mudar sem medir de novo

Cada item abaixo tem número atrás. Trocar sem refazer a medida desfaz uma decisão
que custou trabalho.

- **`page_size = 4096`** no banco de modelo. O 360 usa 65536 e está certo lá,
  porque o BLOB dele é uma foto de megabytes. Aqui o tile médio tem 39,9 KiB e
  64 KB desperdiça 21,9% de disco sem ganho de leitura.
- **`journal_mode = OFF` na carga, `DELETE` no fecho.** OFF na carga: 0,9 s
  contra 49,8 s. DELETE no fecho: em WAL o SQLite cria o `-shm` ao abrir, e num
  volume `:ro` isso derruba o serviço com erro que não aponta a causa.
- **Draco, e não meshopt.** Empatam no Cesium com carga paralela; o meshopt custa
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

- **Windows segura o arquivo.** Um handle SQLite aberto impede substituir o
  `.3dtiles` (`EPERM`). O `connection.js` expõe `closeModelDb` para isso, e o
  roteiro de importação chama antes de mexer no arquivo.
- **Tile vazio existe.** No Ponte_Quatis são 5 em 7.501: sem malha e sem imagem,
  já assim na origem. Nenhuma régua pode exigir Draco deles.
- **A URI é relativa ao próprio `tileset.json`.** Um `Data/c00.glb` dentro de
  `Data/d000/tileset.json` aponta `Data/d000/Data/c00.glb`. Resolver contra a
  raiz dá chave inexistente, e a conferência acusa falso.
- **`asset.version: "0.0"`** aparece em 7 modelos do acervo (saída do DJI Terra).
  É inválido pelo esquema; a conversão normaliza.
