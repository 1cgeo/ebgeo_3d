# Operação

Como importar um modelo, o que conferir em cada passo, e o que fazer quando algo
reprova.

## Antes de começar

O binário `ktx` do KTX-Software 4.4 ou mais novo precisa responder. A importação
confere isso **antes** de qualquer trabalho, e por um motivo concreto: sem o
`ktx`, cada tile sairia com a textura pulada e um aviso que passa despercebido, e
a corrida terminaria com o modelo inteiro sem compressão de textura, sem erro.

```bash
# Windows: instalador em github.com/KhronosGroup/KTX-Software/releases
# depois aponte no .env
KTX_BIN=C:/Program Files/KTX-Software/bin/ktx.exe

# Linux e o container: ja esta no PATH (pacote ktx-tools)
```

Use os atalhos do npm, que leem o `.env`:

```bash
npm run importar -- --origem <dir> --id <slug>
```

O `--` antes das opções é obrigatório: sem ele o npm engole os nomes e o roteiro
recebe só os valores. Chamando `node scripts/importar.js` direto, o `.env` **não**
é lido, e a variável tem de vir do ambiente da sessão.

O `--dry-run` não precisa do `ktx`: a conferência do binário roda depois do
inventário, para o reconhecimento funcionar em máquina sem nada instalado.

## Onde rodar: ler do externo, escrever no interno

Medido com doze workers, mesma amostra:

| arranjo | tiles/s |
|---|---|
| lê e escreve no SSD | 30,76 |
| lê e escreve no disco externo | 30,38 |
| **lê do externo, escreve no SSD** | **34,71** |

O disco não é o gargalo, a CPU é: a 30 tiles por segundo o conversor lê cerca de
1,2 MiB/s. Copiar o modelo para o PC antes não compra desempenho nenhum.

O arranjo recomendado não é o mais rápido no papel, é o que sobrevive a uma queda
do barramento USB: **o roteiro lê da origem e nunca escreve nela**. Se o disco
cair no meio de uma corrida de horas, perde-se a corrida e não o acervo.

## Importar um modelo

```bash
# 1. reconhecimento, sem escrever nada
node scripts/importar.js --origem "D:/modelos_3d/Ponte_Quatis" --id ponte-quatis --dry-run

# 2. piloto de 40 tiles, para ver a razão de tamanho e a taxa antes de escalar
node scripts/importar.js --origem "D:/modelos_3d/Ponte_Quatis" --id piloto --limite 40

# 3. a corrida
node scripts/importar.js --origem "D:/modelos_3d/Ponte_Quatis" \
  --id ponte-quatis --nome "Ponte General Osório (Quatis)" --workers 12
```

Uma importação com `--limite` entra no catálogo com `published = 0` e responde
404 nas rotas públicas. Isso é de propósito: modelo parcial não vai ao ar por
esquecimento.

O `--id` aceita só minúsculas, dígitos, hífen e sublinhado, e tem de começar por
letra ou dígito. Ele é o slug da URL e o nome do arquivo, então escolha-o antes:
mudá-lo depois obriga a reimportar. O nome de pasta do acervo (`Ponte_Quatis`) é
recusado.

Sem `--workers`, a importação usa o número de núcleos menos dois, com teto de
doze. O `--qlevel` sobrepõe a qualidade padrão 200 do ETC1S e fica gravado no
catálogo, então só o mude com medida na mão.

**Reserve espaço em três lugares:** no destino cabem o modelo novo e o antigo ao
mesmo tempo, porque os dois convivem até a troca; e cada worker grava um PNG sem
compressão por textura no `%TEMP%` (`TMPDIR` no Linux), apagando-o em seguida.

### Os sete passos, e o que cada um confere

| passo | o que faz | o que reprova |
|---|---|---|
| 1 | inventário da origem | sem tile, sem `tileset.json` na raiz, `.pnts`, `.i3dm` ou `.cmpt` na árvore |
| 2 | abre o banco com nome `.parcial` | - |
| 3 | converte com N workers, gravando direto no banco | qualquer tile que estourou |
| 4 | reescreve os `tileset.json` | JSON inválido |
| 5 | conferência um a um | tile ausente, referência quebrada |
| 6 | fecha o banco e o põe no lugar | - |
| 7 | registra no catálogo | - |

O roteiro **para no primeiro passo que reprovar**, e o arquivo `.parcial` não
vira modelo. A origem não é tocada em nenhuma hipótese.

A conferência do passo 5 cobre a mesma extensão da escrita: se a origem tem 7.501
tiles, ela procura os 7.501 no banco, um a um, e depois confere que toda `uri`
que os `tileset.json` publicam existe como chave. Ela só vale porque **reprova** o
estado anterior: rode com `--limite` e ela acusa as referências quebradas.

### Escolhendo `--workers`

Satura em doze na máquina de teste (i9-13900K, 24 núcleos):

| processos | tiles/s (DJI Terra) |
|---|---|
| 1 | 1,68 |
| 4 | 5,36 |
| 8 | 7,78 |
| **12** | **9,08** |
| 16 | 8,94 |

Nos tiles do Metashape, bem menores, doze workers chegam a 54,2 tiles/s.

### Quanto tempo leva

Extrapolando as taxas medidas para o acervo inteiro:

| motor | tiles | taxa | tempo |
|---|---|---|---|
| Metashape | 2.211.888 | 54,2 t/s | 11,3 h |
| DJI Terra | 43.326 | 9,08 t/s | 1,3 h |
| | | | **~12,6 h** |

Um modelo por vez. O `Ponte_Quatis` (7.501 tiles, 256,0 MiB) leva 2,3 min.

## Reimportar

```bash
node scripts/importar.js --origem <dir> --id <slug> --forcar
```

O `--forcar` é obrigatório quando o modelo já está no catálogo. A reimportação
gera um token novo, então:

- os `tileset.json` saem com `?v=<token novo>` em toda `uri`;
- o navegador que segura o `tileset.json` velho continua sendo servido, com os
  bytes de hoje, até revalidar o documento (que é `no-cache`);
- o `tiles-queries.js` confere mtime e tamanho a cada acesso e reabre a conexão
  sozinho, então **não é preciso reiniciar o serviço**.

### Reimportar no Windows com o serviço no ar

**Não funciona, e o roteiro avisa.** No Linux, que é onde o container roda,
substituir um arquivo com handle aberto é permitido: o inode antigo sobrevive até
o último leitor fechar. No Windows o mesmo passo devolve `EBUSY`, porque o
serviço é outro processo e segura o arquivo.

Quando isso acontece o trabalho **não se perde**: a conversão já terminou e
passou na conferência, e o `.parcial` está pronto. Pare o serviço e rode:

```bash
node scripts/importar.js --promover --id <slug>
```

O `--promover` não reconverte nada. Ele lê o cabeçalho que o passo 6 gravou no
próprio `.parcial`, troca o arquivo e escreve o catálogo. Ele recusa um
`.parcial` cujo cabeçalho esteja incompleto, ou cuja contagem de tiles não bata
com o que o arquivo tem.

### Códigos de saída

Para a fila dos 115 modelos distinguir reprovação de problema de arquivo:

| código | `importar.js` |
|---|---|
| 0 | importou |
| 2 | uso errado, `--id` inválido, origem inexistente |
| 3 | modelo já no catálogo, e sem `--forcar` |
| 4 | sem tile, sem `tileset.json` na raiz, ou contêiner recusado |
| 5 | conversão com erro, JSON inválido, ou conferência reprovada |
| 6 | troca do arquivo bloqueada: use `--promover` |
| 7 | cabeçalho do `.parcial` incompleto |

O `verificar.js` sai com 0 (aprovado), 1 (reprovado), 2 (uso) ou 3 (modelo ou
arquivo ausente).

### O que uma corrida interrompida deixa

Uma reprovação nos passos 3, 4 ou 5 deixa `data/models/<slug>.3dtiles.parcial` no
disco, do tamanho do modelo. Ele só é apagado na próxima corrida do mesmo `--id`.
Um `Ctrl+C` deixa, além disso, a linha de `imports` em `rodando` para sempre,
porque só o fecho normal a atualiza.

## Conferir antes de publicar

```bash
node scripts/verificar.js --id <slug> --origem <dir>
```

Ele abre o arquivo publicado do jeito que o serviço abre, e reprova por
`asset.version` errado, `gltfUpAxis` sobrevivente, URI quebrada, URI sem token,
tile que não abre como glTF, malha sem Draco e imagem sem KTX2. Sai com código 1
se reprovar em qualquer ponto, então cabe num laço.

## Remover um modelo

Não há comando. Com o serviço parado:

```sql
-- data/index.db
DELETE FROM models WHERE id = 'piloto';
DELETE FROM imports WHERE model_id = 'piloto';
```

E apague `data/models/piloto.3dtiles`. Vale sobretudo para os pilotos de
`--limite`, que ficam no catálogo despublicados.

## O que a importação deixa nulo

Ela preenche só o que consegue medir. Ficam nulos e entram por `UPDATE` no
`index.db`: `description`, `local`, `keywords`, `max_sse`, `height_offset`,
`captured_at`, `preview_video` e `preview_thumb`. O `upsert` da reimportação
preserva o que você editou, então a edição não se perde.

O `locate.height` do catálogo é a altura do chão mais 500 m, que é a distância de
câmera para o modelo caber na tela.

## O ponto de navegação e a altura do chão

A importação mede os dois, e nenhum dos dois se preenche a mão.

Ela tenta primeiro o que o tileset declara: `properties.Longitude/Latitude`, que
o Metashape grava em RADIANOS, ou `boundingVolume.region`. O DJI Terra não
publica nenhum dos dois, só `boundingVolume.box`. Nesse caso a importação percorre
a árvore inteira e mede o envelope geodésico.

O cuidado que faz a conta valer está no código: o box de um tile é local ao
`transform` acumulado, e não ECEF. O `transform` mora no root do tileset EXTERNO.
Ler o box direto põe o modelo no golfo da Guiné.

Duas colunas saem daí:

- `lon`, `lat`, `height`: o ponto de navegação.
- `ground_height`: a altura elipsoidal do chão, a mediana das alturas dos cantos
  dos tiles de conteúdo. Ela é DADO, e a reimportação a sobrescreve.

Modelo importado antes de 2026-08-22 tem o ponto errado ou vazio. Refaça a medida
sem reconverter:

```bash
node scripts/remedir.js --dry-run          # mostra o deslocamento de cada modelo
node scripts/remedir.js                    # grava
node scripts/remedir.js silo-dona-francisca
```

O roteiro imprime a distância entre o ponto do catálogo e o medido. Acima de 50 m
ele marca `DESLOCADO`.

## Teto de resolução de textura

`--max-textura 512` reduz o lado maior de toda textura acima do teto, mantendo a
proporção. Ele vem DESLIGADO.

Ligue só com decisão do chefe, porque a troca aparece. Medido no Silo Oreste
Ceretta, do DJI Terra:

| | disco | conversão | VRAM de perto |
|---|---|---|---|
| sem teto | 338,4 MiB | 245,4 s | 45,0 MiB |
| `--max-textura 512` | 214,5 MiB | 118,2 s | 31,1 MiB |

O tempo de carga no cliente **não muda**. O teto compra disco e VRAM, e não
velocidade. E de perto ele amacia a telha do galpão. Ver `docs/desempenho.md`.

Vale só para o DJI Terra, que exporta 1024×1024. O Metashape exporta 256 a 512, e
ali o teto não faz nada.

## Modelo que flutua

O sintoma é o modelo pairando sobre um chão liso. A causa quase nunca é o modelo.

Um CesiumJS que não consegue carregar o terreno cai EM SILÊNCIO para o
`EllipsoidTerrainProvider`. O chão vira uma superfície lisa na altura 0, e todo
modelo passa a flutuar a própria altura elipsoidal. Confira o terreno antes de
mexer no modelo:

```bash
curl -o /dev/null -s -w "%{http_code}
" http://localhost/terrain/tilesets/terrain/layer.json
```

Código `000` ou `404` confirma o diagnóstico. Com o terreno da DGEO no ar, o
`height_offset` é 0, e é assim que o catálogo o publica.

Na máquina sem terreno, gere o config com o contorno em vez de ajustar no olho:

```bash
node scripts/catalogo.js --js --sem-terreno --base http://localhost:8082
```

A opção publica `heightOffset = -ground_height`. NUNCA a use para o config de
produção.

## Publicar e despublicar

```sql
-- data/index.db
UPDATE models SET published = 0 WHERE id = 'ponte-quatis';
```

Modelo despublicado some do catálogo e responde 404 nas rotas. O arquivo continua
onde está.

## Ligar no ebgeo_web

No `src/js/config.js` do `ebgeo_web`, a entrada do tileset troca só a URL:

```js
// antes: arvore estatica em public/3d
{ url: "/3d/PCL/tileset.json", id: "PCL", ... }

// depois: servico
{ url: "/ebgeo_3d/api/v1/models/pcl/tileset.json", id: "pcl", ... }
```

Nada mais muda no cliente. O CesiumJS resolve as `uri` de dentro do
`tileset.json` relativas a essa URL, e o serviço entrega cada uma pela rota
curinga.

Em desenvolvimento a URL é `http://localhost:8082/api/v1/models/<id>/tileset.json`.
Em produção o proxy publica o serviço em `/ebgeo_3d` e repassa `/api/v1/...`,
exatamente como já faz com o 360.

O catálogo pronto para colar no `config.tilesets` sai de:

```bash
curl "http://localhost:8082/api/v1/models?base=/ebgeo_3d"
```

## Conferir depois de publicar

O log do serviço não prova que o cliente desenhou. A conferência que vale é
abrir o modelo no EBGeo e olhar. O que checar:

1. o modelo aparece no catálogo e na busca;
2. a cena desenha com textura, e não branca (textura branca é KTX2 que o
   navegador não transcodificou);
3. no painel de rede, os tiles saem do serviço com `200` e `?v=<token>`;
4. uma segunda visita traz `304` nos tiles, e não `200`.

## Quando algo reprova

| sintoma | causa provável |
|---|---|
| `binario 'ktx' nao responde` | KTX-Software ausente ou `KTX_BIN` errado |
| razão alta com `ATENCAO: N texturas o codificador recusou` | o binário `ktx` rejeitou as texturas, em geral por versão anterior à 4.4. Falha do `sharp` não produz este sintoma: ela derruba a corrida no passo 3 |
| `referencias quebradas` no passo 5 sem `--limite` | um `tileset.json` aponta arquivo que não existe na origem |
| `nao converte` no passo 1 | a árvore tem `.pnts`, `.i3dm` ou `.cmpt`; eles pedem outro pipeline |
| `nenhum worker respondeu em 60 s` | o worker não carregou, quase sempre `sharp` ou `draco3dgltf` sem binário para esta versão de Node; rode `npm test` para isolar |
| globo liso, modelo não aparece | URL errada no `config.js`, ou modelo com `published = 0` |
| modelo aparece branco | KTX2 sem transcodificador no cliente, ou CesiumJS anterior a 1.83 |
| `EBUSY` ou `EPERM` ao substituir o `.3dtiles` | serviço no ar segurando o arquivo, no Windows. Pare o serviço e use `--promover` |

## Manutenção

```bash
# So para .3dtiles vindos de fora: a importacao ja fecha todo modelo em
# journal_mode = delete. Rode com o servico parado, porque ele abre para escrita.
npm run cleanup-wal
npm test               # 21 testes
npm run lint
```
