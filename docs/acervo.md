# Estado do acervo

Onde a migração do acervo parou, o que falta e por quê. Atualize este arquivo
quando o número mudar.

Medido em 2026-08-25.

## O número

**111 das 115 pastas da origem estão convertidas**, 86,4 GiB e 2.130.289 tiles.
Todas passaram pela conferência do `verificar-lote.js`, que confronta o produto
com a origem tile a tile e referência a referência.

A `passadeira` entrou em 2026-08-25, depois que o índice do ramo perdido voltou.
Ver "O ramo que voltou", abaixo.

A varredura completa da origem rodou em 2026-08-23: **2.236.320 arquivos, 115
modelos, 112 íntegros** e três com achado. Ela levou 10,8 min, a 3.442 arquivos
por segundo.

```bash
npm run varrer                                 # a origem inteira
node scripts/varrer-origem.js --piloto 3       # mede a taxa antes de escalar
```

A origem fica na pasta que `EBGEO3D_SOURCE_DIR` aponta, e o destino é o
argumento `--destino` do lote. As duas vivem no HD externo.

```bash
npm run cruzar -- --destino <pasta do HD>     # o que atravessou, e o que nao
npm run verificar:lote -- --destino <pasta do HD>
```

## As quatro que faltam

Nenhuma falhou por defeito da conversão. Três precisam de decisão sua, e uma
perdeu dado que não existe no disco.

### `estatua`: falta a posição

Um `.glb` de 630 KB, sem posição em lugar nenhum. O formato não carrega
georreferência, e o `config.js` do `ebgeo_web` não tem entrada para ele.

```bash
npm run importar:glb -- --origem <pasta> --id estatua --lon <N> --lat <N>
```

### `area3_tiles` e `museu-1cgeo`: Gaussian splatting

A conversão destruiria os atributos do splat. O `museu-1cgeo` tem roteiro
próprio (`importar-cena.js`) e não vira `.3dtiles`. O `area3_tiles` precisa ser
servido como árvore, ou tratado antes.

### `TanqueDeFerro`: o dano não está num ramo só

Ele perdeu o `tileset.json` do ramo `Data/d102`, e com ele 1.175 tiles ficaram
órfãos. **Mas o dano é maior do que esse, e a varredura o revelou.** Além do
índice perdido, **288 tiles que os tilesets referenciam não existem no disco**,
espalhados por 18 dos 22 ramos. As 288 foram conferidas uma a uma, e nenhuma é
falso positivo. Reconstruir o índice do `d102` não salvaria o modelo, porque o
dano não está num ramo só.

O `importar.js` para no `JSON invalido` antes de converter, e está certo: sem o
índice, os tiles do ramo não têm posição nem limiar de LOD.

**Reconstruir o índice é viável**, e as três condições foram medidas em
2026-08-23. Elas continuam valendo para o `TanqueDeFerro`, ainda que ali a
reconstrução não baste:

1. os tiles estão legíveis e declaram a própria caixa (`min`/`max` do accessor
   de POSITION), 40 de 40 na amostra dos dois;
2. a hierarquia está nos nomes, no padrão do ContextCapture (`a` na raiz, depois
   um dígito por nível: `b0..b3`, `c00..c33`);
3. os ramos vizinhos têm `tileset.json` válido e servem de molde
   (`boundingVolume` do tipo `box`, sem `transform`).

O método teria como se provar antes de ser usado: **reconstruir o índice de um
ramo são e comparar com o real que já está no disco**. Sem esse teste, a
reconstrução é chute. O `geometricError` continua sendo a parte aproximada, e
reprocessar no software de origem dá resultado exato.

## O ramo que voltou: a `passadeira`

Ela ficou de fora porque o `Data/d033` perdeu o `tileset.json`, e sem índice os
405 tiles do ramo não tinham posição nem limiar de LOD. Em 2026-08-24 o ramo
voltou inteiro, e a conversão saiu no dia seguinte: 8.357 tiles em 4,0 min a
34,6 tiles/s (Metashape, eixo Y), 236,1 MiB, com 0 tile ausente e 0 referência
quebrada. O `verificar.js` aprovou contra a árvore restaurada.

**O índice que volta se confere ANTES de converter, e a conta é barata**: as 591
uris que ele publica existem todas no disco, e os 591 `.b3dm` da pasta são
exatamente essas. Nenhuma referência quebrada, nenhum tile órfão, nenhum arquivo
de 0 byte nos 8.374.

### Não foi só o índice que voltou, e isso muda a conferência

Duas contagens do mesmo ramo discordaram — 405 tiles neste documento contra 591
medidos —, e as duas estavam certas. Elas mediam coisas diferentes:

| | b3dm no `d033` | b3dm no modelo |
|---|---|---|
| origem em `EBGEO3D_SOURCE_DIR` | 405 | 8.171 |
| árvore restaurada, que converteu | 591 | 8.357 |

Os 405 comuns são **idênticos byte a byte**. Os outros **186 nunca existiram na
origem**: o ramo não foi reindexado, foi reprocessado no software de origem. A
perda tinha levado o índice E parte dos tiles.

**Consequência para o `verificar-lote.js`: ele vai REPROVAR a `passadeira`
enquanto a origem for a antiga.** O produto tem 8.357 tiles e a origem tem
8.171, e produto acima do total reprova, por desenho (ver "Tiles que ninguém
alcança"). O alarme está correto, e a cura é promover a árvore restaurada a
origem — nunca calar a régua.

## O ramo que foi remendado, e como

O `estrela-merge` converteu com um remendo, e o caso vale como método.

O `estrela0` tinha **329 arquivos de 0 byte, todos confinados ao ramo
`Data/f03000`**: 328 tiles mais o `tileset.json` do ramo. As outras duas pastas
do modelo (`estrela0-antigo` e `estrela1`) não tinham nenhum.

O remendo veio do `estrela0-antigo`, e a prova de que ele servia foi medida, não
suposta:

- dos 747 tiles do ramo, os **419 que existem nos dois são idênticos byte a
  byte**, e os 328 restantes são exatamente os vazios;
- nos 107 ramos que dá para comparar por inteiro, tiles e índices batem 100%;
- o `@3dtilesIndex1@` é idêntico byte a byte nas duas versões.

Duas medidas erradas foram descartadas no caminho, e o registro delas importa:
uma amostra de 5 tiles disse que o remendo servia (os 5 primeiros em ordem
alfabética são de nível raso, e nenhum deles estava vazio), e a comparação por
`RTC_CENTER` não mediu nada, porque nenhum tile do ramo tem um.

**O remendo não tocou a origem.** Ele é montado numa cópia no PC, com
conferência que reprova se sobrar qualquer arquivo vazio, e some com ela.

O `estrela0-antigo` não entra na conversão: o `tileset.json` da raiz referencia
só `estrela0/` e `estrela1/`. Levá-lo custaria 4,15 GiB e nenhum pixel.

## Se aparecer arquivo de 0 byte de novo

Perda concentrada num ramo só, com as pastas vizinhas intactas, é a assinatura
de cópia interrompida ou de setor com defeito. O índice que falta no
`TanqueDeFerro` pode ser o mesmo fenômeno, e o da `passadeira` era.

A varredura é barata, e vale antes de reprocessar qualquer coisa: um `stat` por
arquivo diz quantos zeros existem e em que ramos eles se concentram.

Ela também não vê tudo. O ramo `d033` da `passadeira` não tinha nenhum arquivo
de 0 byte: tinha 186 tiles que simplesmente **não estavam lá**, e só a travessia
a partir da raiz, ou a comparação com uma árvore íntegra, revela essa forma de
perda.

## Tiles que ninguém alcança

A varredura de 2026-08-23 achou um segundo padrão, que não é dano e vale
conhecer: **tile que existe na pasta e que nenhum tileset referencia**.

O `14ciaecmb` tem 1.942 deles, em três ramos inteiros (`d030`, `d031`, `d032`),
com índice próprio e tudo. O Cesium nunca os carrega, porque não há caminho da
raiz até eles. O `estrela-merge` tem 94.034, na pasta `estrela0-antigo`, e essa
pasta **não entrou** no `.3dtiles`: o produto tem 152.787 tiles, só de
`estrela0` e `estrela1`.

Podar os três ramos do `14ciaecmb` custa **65,0 MiB** de 405,9, e a pasta podada
fecha sozinha: 8.132 tiles alcançáveis, 8.132 no disco, 0 referência quebrada.
Nenhum pixel se perde. O `.3dtiles` publicado ainda carrega os 1.942.

**Meça o custo somando bytes, e nunca com `du`.** No HD externo o `du` acusou
246 MB para esses três ramos, contra 65,0 MiB reais: ele conta alocação, e o
volume reserva 128 KiB por arquivo. Com 973 arquivos pequenos o erro é de quase
quatro vezes.

O conversor copia a PASTA, então o produto sai fiel ao total, e não ao
alcançável. Isso é correto, e a conferência precisou aprender a diferença: ela
compara **três** números, e não dois.

| número | o que é |
|---|---|
| alcançável | o que a travessia dos tilesets atinge a partir da raiz |
| total | o que existe na pasta |
| produto | o que o `.3dtiles` guarda |

Produto abaixo do alcançável é falha de conversão, sempre. Produto entre o
alcançável e o total é fidelidade à origem, e sai como fato apontando o lixo que
está lá. Produto acima do total reprova. A regra vive em `lib/copia.js`, com
teste, porque calar um alarme falso é perigoso e alguém precisa garantir que o
alarme verdadeiro continua tocando.

## Quando o disco cai no meio

A conferência **para** e diz onde parou, em vez de reprovar tudo o que vem
depois. Medido em 2026-08-23: o HD caiu perto do fim de uma passagem, e os 11
modelos seguintes saíram como reprovados com `disk I/O error`, todos intactos.
Onze alarmes falsos em cascata desmoralizam a conferência inteira, porque ensinam
a duvidar também dos verdadeiros. O código de saída nesse caso é 3.
