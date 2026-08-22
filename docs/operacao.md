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

### Os sete passos, e o que cada um confere

| passo | o que faz | o que reprova |
|---|---|---|
| 1 | inventário da origem | sem tile, sem `tileset.json` na raiz, container que não é b3dm nem glb |
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
| razão de tamanho perto de 1,4 e nenhuma textura contada | o `sharp` não decodificou a origem; veja o formato da textura de entrada |
| `referencias quebradas` no passo 5 sem `--limite` | um `tileset.json` aponta arquivo que não existe na origem |
| `container "pnts" nao e convertido` | o modelo tem nuvem de pontos; ele não passa por este roteiro |
| globo liso, modelo não aparece | URL errada no `config.js`, ou modelo com `published = 0` |
| modelo aparece branco | KTX2 sem transcodificador no cliente, ou CesiumJS anterior a 1.83 |
| `EBUSY` ou `EPERM` ao substituir o `.3dtiles` | serviço no ar segurando o arquivo, no Windows. Pare o serviço e use `--promover` |

## Manutenção

```bash
npm run cleanup-wal    # tira os bancos do WAL, para publicar em volume :ro
npm test               # 21 testes
npm run lint
```
