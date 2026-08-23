# Estado do acervo

Onde a migração do acervo parou, o que falta e por quê. Atualize este arquivo
quando o número mudar.

Medido em 2026-08-23.

## O número

**110 das 115 pastas da origem estão convertidas**, 86,1 GiB em `.3dtiles`.
Todas passaram pela conferência do `verificar-lote.js`, que confronta o produto
com a origem tile a tile e referência a referência.

A origem fica na pasta que `EBGEO3D_SOURCE_DIR` aponta, e o destino é o
argumento `--destino` do lote. As duas vivem no HD externo.

```bash
npm run cruzar -- --destino <pasta do HD>     # o que atravessou, e o que nao
npm run verificar:lote -- --destino <pasta do HD>
```

## As cinco que faltam

Nenhuma falhou por defeito da conversão. Três precisam de decisão sua, e duas
precisam de dado que não existe no disco.

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

### `passadeira` e `TanqueDeFerro`: falta um índice de ramo

Cada um perdeu o `tileset.json` de um ramo:

| modelo | ramo | tiles órfãos |
|---|---|---|
| `passadeira` | `Data/d033` | 405 |
| `TanqueDeFerro` | `Data/d102` | 1.175 |

O `importar.js` para no `JSON invalido` antes de converter, e está certo: sem o
índice, os tiles do ramo não têm posição nem limiar de LOD.

**Reconstruir o índice é viável**, e as três condições foram medidas em
2026-08-23:

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
de cópia interrompida ou de setor com defeito. Os dois índices que faltam na
`passadeira` e no `TanqueDeFerro` podem ser o mesmo fenômeno.

A varredura é barata, e vale antes de reprocessar qualquer coisa: um `stat` por
arquivo diz quantos zeros existem e em que ramos eles se concentram.
