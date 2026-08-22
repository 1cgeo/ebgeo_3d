# Formato

O padrão que este serviço produz e entrega, com a medida que sustenta cada
escolha. Toda medida saiu do acervo real da DGEO em 2026-08-22.

## O alvo

| camada | escolha | extensão glTF |
|---|---|---|
| tileset | 3D Tiles 1.1 | - |
| conteúdo | glTF binário (`.glb`) | - |
| geometria | Draco, método edgebreaker | `KHR_draco_mesh_compression` |
| textura | KTX 2.0 com Basis ETC1S, qlevel 200 | `KHR_texture_basisu` |
| material | mantém o que a origem trouxe | `KHR_materials_unlit` |
| empacotamento | um SQLite por modelo (`.3dtiles`) | - |

## Por que 3D Tiles 1.1

A versão 1.1 saiu em 2023-01-09 (aprovada pela OGC em 2022-12-17) e nada a
substituiu. Ela troca os contêineres antigos (`b3dm`, `i3dm`, `pnts`, `cmpt`) por
glTF 2.0 direto como conteúdo de tile.

O acervo hoje declara três versões nos 115 `tileset.json` de raiz:

| `asset.version` | modelos | situação |
|---|---|---|
| 1.0 | 100 | válido, formato de conteúdo depreciado em 1.1 |
| 0.0 | 7 | **inválido pelo esquema**, todos do DJI Terra |
| 1.1 | 5 | válido |

A conversão normaliza os três para 1.1.

## Por que KTX2, e qual é o ganho de verdade

O ponto do KTX2 não é o download, é o que acontece depois dele. JPEG, PNG e WebP
descomprimem para RGBA8 na memória de vídeo. O KTX2 transcodifica em tempo de
carga para o formato nativo da GPU (BC1 no desktop, ETC ou ASTC no móvel) e
**permanece comprimido lá**.

Medido dentro do CesiumJS 1.138, o mesmo binário que o `ebgeo_web` embarca, com
as estatísticas lidas da API do próprio Cesium, 150 tiles de cada motor:

**Metashape** (textura de 256 a 768 px)

| variante | carga | rede | VRAM textura | FPS |
|---|---|---|---|---|
| Draco + JPEG (hoje) | 262 ms | 8,37 MiB | 111,25 MiB | 59,7 |
| Draco + KTX2 q200 | 268 ms | 10,01 MiB | **13,91 MiB** | 59,7 |

**DJI Terra** (textura de 1024 px)

| variante | carga | rede | VRAM textura | FPS |
|---|---|---|---|---|
| Draco + WebP (hoje) | 1.410 ms | 38,88 MiB | 446,38 MiB | 55,4 |
| Draco + KTX2 q200 | **702 ms** | 30,96 MiB | **55,80 MiB** | 59,5 |

O fator de 8 na memória de textura vale nos dois motores. No DJI Terra o KTX2
também corta a carga pela metade, porque decodificar WebP de 1024 px custa caro
na CPU e transcodificar ETC1S para BC1 não.

Num tileset inteiro o número fica mais claro. Ponte de Quatis, vista a 110 m,
`maximumScreenSpaceError` 4:

| | hoje | convertido |
|---|---|---|
| VRAM textura | **1.434,5 MiB** | **205,8 MiB** |
| tiles carregados | 2.894 | 3.290 |
| triângulos | 2.592.368 | 2.790.189 |

Uma vista de um modelo pequeno pede 1,4 GiB de memória de vídeo só de textura no
formato de hoje. A máquina de teste tem uma RTX 4070 Ti e aguenta. Um notebook
com vídeo integrado, não.

**O que o KTX2 NÃO faz é economizar banda nos modelos Metashape.** A textura
deles já está em 1,60 bit por texel, e a pirâmide de mipmap que o KTX2 carrega
junto acrescenta um terço. Medido em 60 tiles, com Draco reaplicado nos dois
lados:

| variante | Metashape | DJI Terra |
|---|---|---|
| como está hoje | 100,0% | 100,0% |
| ETC1S q128 | 91,3% | 60,2% |
| **ETC1S q200** | **119,3%** | **76,1%** |
| ETC1S q255 | 129,2% | 85,6% |
| UASTC nível 4 | 395,7% | 281,2% |

Os 10 a 30% de redução que o Cesium publica valem contra JPEG folgado, não
contra o JPEG apertado do Metashape. Quem medir o resultado pela régua da banda
vai concluir que a conversão falhou.

## Por que qlevel 200

É o joelho medido da curva. PSNR do ETC1S contra a textura de origem já
decodificada, transcodificado de volta para RGBA8:

| qualidade | Metashape | pior caso | DJI Terra | pior caso |
|---|---|---|---|---|
| q128 | 35,33 dB | 33,08 | 29,84 dB | 24,67 |
| **q200** | **37,15 dB** | 35,44 | **32,84 dB** | 28,32 |
| q255 | 37,31 dB | 35,97 | 33,83 dB | 30,50 |

De q200 para q255 o Metashape ganha 0,16 dB e paga 8% de bytes. O q128 é barato
demais no DJI Terra: 24,67 dB no pior caso deixa artefato visível em telhado e
asfalto.

Confirmado na tela: a vista de 110 m sobre a ponte, original contra convertido,
não mostra diferença no asfalto, no guarda-corpo nem na vegetação, que são as
três superfícies onde o ETC1S falha primeiro.

## Por que Draco, e não meshopt

Os dois são ratificados e resolvem o mesmo problema com perfis de custo opostos:
o Draco entrega arquivo menor, o meshopt decodifica mais rápido.

Uma primeira medida, carregando os tiles **em série**, dava meshopt 2,5 vezes
mais rápido. O número era do instrumento, não do fenômeno: o Cesium decodifica
Draco num Web Worker, e em série cada tile pagava um quadro inteiro de espera.
Carregando **em paralelo**, que é como o Cesium carrega um tileset de verdade, os
dois empatam (702 contra 623 ms em 150 tiles, dentro do ruído).

Empatando o desempenho, decide o tamanho: o meshopt custa 17% a mais de bytes.

## Por que ETC1S, e não UASTC

UASTC é o modo de alta qualidade do Basis, com bitrate fixo de 8 bits por texel.
Ele existe para normal map e arte principal, onde artefato aparece. Em ortofoto
de fotogrametria ele custa de 2,8 a 4 vezes o tamanho do arquivo de hoje sem
ganho visível.

## O token de geração

Toda `uri` de conteúdo dentro dos `tileset.json` sai com `?v=<token>`:

```json
{ "content": { "uri": "Data/d000/c00.glb?v=mt4b2d00" } }
```

O tile é servido com `Cache-Control: immutable` de um ano. Sem o token, uma
reimportação trocaria os bytes sem trocar a URL, e o navegador que já visitou o
modelo passaria o ano compondo tile velho dentro da árvore nova, **sem um erro no
console**. O `ebgeo_360` já pagou exatamente esse defeito na pirâmide das
panorâmicas.

O `tileset.json` em si vai com `no-cache` mais ETag, e não com `immutable`: ele é
o documento que muda numa reimportação, e é por ele que o cliente descobre o
token novo.

A rota **ignora** o token que chega na URL, de propósito. Ele não é parâmetro: é
o que separa a URL do tile velho da do novo, e quem o consome é o cache. Comparar
o token com o do banco recusaria o pedido do cliente que ainda segura o
`tileset.json` anterior, e pintaria a cena de buraco em vez de servir o tile bom.

## O empacotamento: um SQLite por modelo

O acervo em árvore de arquivos tem **2.261.536 arquivos** com média de 44,2 KiB.
Isso custa caro em tudo que é cobrado por arquivo e não por byte: backup, cópia
para produção, varredura de antivírus, listagem de diretório. O maior modelo,
sozinho, tem 247.125 arquivos.

Três formas de guardar o mesmo modelo, medidas em Node com a mesma amostra
(Ponte de Quatis, 7.501 tiles, mediana de 7 rodadas intercaladas):

| formato | leitura aleatória | disco |
|---|---|---|
| `.3tz` (zip com índice) | 67.720 tiles/s | 289 MiB |
| `.3dtiles` (SQLite) | 27.012 tiles/s | 294 MiB |
| árvore de arquivos | 2.092 tiles/s | 288 MiB |

O 3TZ é mais rápido. **Mas os três estão entre 2 mil e 68 mil tiles por segundo,
e uma cena do Cesium pede algumas centenas.** A leitura sobra por duas ordens de
grandeza nos dois formatos empacotados, e por isso não é critério de escolha.

O critério é operacional, e aí o SQLite ganha: a DGEO já opera 65 GB assim no
`ebgeo_360`, com `better-sqlite3` compilado, pragmas afinados e as armadilhas já
documentadas. O terreno já usa MBTiles, o vetor usa PMTiles. O 3D em árvore de
arquivos era a exceção.

O formato do arquivo é o `.3dtiles` do `3d-tiles-tools` do Cesium, tabela
`media(key, content)`. Um arquivo escrito aqui abre com
`npx 3d-tiles-tools convert`, e um deles abre aqui.

## `page_size` 4096, e não 65536

O `ebgeo_360` usa `page_size = 65536` e está certo lá: o BLOB dele é uma foto de
500 KB a 4 MB. Aqui o tile médio tem 39,9 KiB, menor que uma página de 64 KB, e o
resto da página vira desperdício. Medido no Ponte de Quatis:

| page | disco | leitura |
|---|---|---|
| **4 KB** | **+2,1%** | 27.012 tiles/s |
| 16 KB | +6,9% | 30.959 tiles/s |
| 64 KB | +21,9% | 30.022 tiles/s |

A diferença de leitura cabe dentro da variação de cada medida (48% a 65% entre a
melhor e a pior rodada). O que sobra é o disco: em 104 GiB de acervo, 4 KB contra
64 KB são cerca de 20 GiB.

## O que a conversão custa em espaço

| motor | razão medida | efeito no acervo |
|---|---|---|
| Agisoft Metashape | 1,1275 a 1,1492 | 84,10 GiB vira ~95 GiB |
| DJI Terra | 0,78 | 11,21 GiB vira ~8,7 GiB |

Total: 96,8 GiB passam a cerca de 104 GiB, mais 8%.

## O que este formato descarta

- **A batch table do b3dm.** No acervo ela vem vazia nos modelos do Metashape e
  sem propriedade útil nos do DJI Terra. O equivalente em 1.1 seria
  `EXT_structural_metadata`, que ninguém consome hoje. A importação **conta** os
  tiles cuja batch table tinha conteúdo e avisa, em vez de jogar fora calado.
- **`asset.gltfUpAxis`.** Nunca existiu no esquema de 1.1, e o glTF já é Y-up por
  definição.

## O que fica de fora, e por quê

- **Gaussian splat.** O Khronos publicou `KHR_gaussian_splatting` como release
  candidate em fevereiro de 2026, e o CesiumJS 1.139 já lê. O acervo tem um
  modelo assim (`area3_tiles`, SPZ 2.0). Ele não passa por esta conversão: não é
  malha, e o formato dele já é o corrente. Um serviço futuro pode servir os dois
  conteúdos no mesmo tile, que o 3D Tiles 1.1 permite.
- **Tiling implícito.** Nenhum modelo do acervo usa. A conversão detecta e não
  adultera um que use.
- **`pnts`, `i3dm` e `cmpt`.** A importação recusa antes de começar, em vez de
  descobrir no meio.
