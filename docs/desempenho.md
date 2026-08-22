# Desempenho

O que a bancada mede, o que ela já mediu, e o que fazer com o número. Toda medida
saiu de `bench/`, nesta máquina (i9-13900K, 24 núcleos, SSD NVMe), contra o
`ponte-quatis` real.

## As duas bancadas, e por que são duas

```bash
npm run bench:http -- --modelo ponte-quatis    # o que o cliente sente
npm run bench -- --modelo ponte-quatis         # a camada SQLite isolada
```

A de HTTP mede requisições por segundo e latência por percentil, com o serviço no
ar. A de banco mede a leitura do BLOB sem o Fastify no meio.

**Separadas de propósito.** No caminho HTTP o custo do banco fica misturado com o
do framework, do keep-alive e do loop de eventos, e uma melhora de 20% no SQLite
some dentro do ruído. Sem a separação ninguém sabe se um pragma ajudou.

## Três armadilhas que estas bancadas já caíram

Cada uma custou uma medida que mentiu, e o código de `bench/` carrega o conserto.

**1. Ordem de execução.** Medir uma configuração inteira e depois a outra mede o
cache de página do sistema esquentando. Isso já inverteu um resultado nosso:
`page_size` 16K apareceu 37% na frente do 4K numa ordem e 16% atrás na outra. As
rodadas são **intercaladas**.

**2. Coletor de lixo.** Cada leitura aloca um Buffer do tamanho do tile, então
uma rodada de 4.000 chaves produz cerca de 160 MB de lixo. Sem `--expose-gc` a
variação entre rodadas passou de 140%, e chegou a mostrar `cache 2 MB` na frente
de `cache 32 MB`, o que é impossível. O `npm run bench` já passa a flag.

**3. A régua tem de ser a dispersão da própria medida.** A bancada de banco
compara pela **melhor rodada** de cada configuração e imprime a régua ao lado.
Diferença menor que a dispersão não sustenta trocar um pragma, e o script diz
isso em voz alta em vez de deixar quem lê concluir sozinho.

## O que já foi medido

### HTTP, tile de conteúdo

| cenário | req/s | MiB/s | p50 | p90 | p99 |
|---|---|---|---|---|---|
| travessia, 1 em voo | 1.593 | 73,1 | 0,44 ms | 0,72 ms | 2,84 ms |
| **travessia, 8 em voo** | **3.645** | **157,5** | 1,99 ms | 2,73 ms | 6,32 ms |
| travessia, 32 em voo | 2.607 | 119,7 | 12,23 ms | 16,38 ms | 18,37 ms |
| sorteio, 8 em voo | 2.615 | 101,2 | 3,21 ms | 3,92 ms | 4,96 ms |

Duas leituras:

- **O pico está em 8 em voo, e 32 piora.** Passar disso enfileira sem ganho.
- **Travessia e sorteio quase empatam.** O banco inteiro cabe no cache de página,
  então o padrão de acesso não decide nada neste modelo. Num modelo de 10 GiB a
  diferença deve aparecer, e a bancada roda os dois justamente para isso.

### HTTP, os outros caminhos

| cenário | req/s | leitura |
|---|---|---|
| 304 com ETag que bate | 6.871 | **1,84x** mais que o 200, e sem corpo |
| 200 do mesmo tile | 3.728 | |
| `tileset.json` | 2.062 | 250,8 MiB/s: são documentos grandes |
| catálogo | 6.868 | |
| `/health` | 7.805 | não abre banco de modelo |
| 404 | 3.631 | |

O 304 valendo quase o dobro é a confirmação de que o caminho curto funciona: ele
responde antes de tocar no BLOB.

### Camada SQLite

Com `--expose-gc` e rodadas intercaladas, nenhuma variação de pragma se destacou
fora do ruído no `ponte-quatis`. `mmap 256 MB` aparece entre +43% e +60% em toda
execução, o que é sinal e não ruído, mas a dispersão de cada medida ainda o
cobre. **É a primeira coisa a decidir com um modelo grande.**

### Distribuição de tamanho de tile

O `ponte-quatis` convertido, 7.501 tiles, 284,2 MiB, média de 38,8 KiB:

| faixa | tiles | bytes |
|---|---|---|
| 0 a 10 KiB | 22,4% | 2,9% |
| 10 a 25 KiB | 17,0% | 7,4% |
| 25 a 50 KiB | 27,4% | 27,7% |
| **50 a 100 KiB** | **30,6%** | **54,2%** |
| 100 a 200 KiB | 2,6% | 7,8% |

**A média engana.** Ela é puxada por muitos tiles minúsculos, que são os nós de
LOD grosso e quase não pesam: 39,4% dos tiles carregam 10,3% dos bytes. Os que
carregam o peso estão em 50 a 200 KiB, que é a faixa que o time do CesiumJS
recomenda. O desenho está certo, e agrupar tiles não é a otimização a perseguir.

## As opções do CesiumJS são a terceira camada, e a mais mal medida

O `ebgeo_web` não usa os defaults do Cesium. O `map_3d.js:createOptimizedTileset`
liga quinze opções, e **nenhuma delas tinha medida**:

```js
preferLeaves: false,            skipLevelOfDetail: true,
baseScreenSpaceError: 1024,     skipScreenSpaceErrorFactor: 16,
skipLevels: 1,                  cacheBytes: 1073741824,
dynamicScreenSpaceError: true,  dynamicScreenSpaceErrorDensity: 0.00278,
dynamicScreenSpaceErrorFactor: 2.0, dynamicScreenSpaceErrorHeightFalloff: 0.25,
cullWithChildrenBounds: true,   cullRequestsWhileMoving: true,
cullRequestsWhileMovingMultiplier: 60.0, foveatedScreenSpaceError: true,
```

### Dez dos quinze são o próprio default

Lidos do objeto `Cesium3DTileset` do CesiumJS 1.138, sem passar opção nenhuma:

| parâmetro | EBGeo | default | |
|---|---|---|---|
| `maximumScreenSpaceError` | 16 | 16 | igual |
| `preferLeaves` | false | false | igual |
| `baseScreenSpaceError` | 1024 | 1024 | igual |
| `skipScreenSpaceErrorFactor` | 16 | 16 | igual |
| `skipLevels` | 1 | 1 | igual |
| `dynamicScreenSpaceError` | true | true | igual |
| `dynamicScreenSpaceErrorHeightFalloff` | 0,25 | 0,25 | igual |
| `cullWithChildrenBounds` | true | true | igual |
| `cullRequestsWhileMoving` | true | true | igual |
| `cullRequestsWhileMovingMultiplier` | 60 | 60 | igual |
| `foveatedScreenSpaceError` | true | true | igual |
| **`skipLevelOfDetail`** | **true** | **false** | difere |
| **`cacheBytes`** | **1 GiB** | **512 MiB** | 2× |
| **`dynamicScreenSpaceErrorDensity`** | **0,00278** | **0,0002** | 13,9× |
| **`dynamicScreenSpaceErrorFactor`** | **2,0** | **24** | 12× menor |

Repetir o default não muda comportamento, mas custa: quem lê a lista supõe que
há decisão medida atrás de cada linha, e o que difere de verdade se esconde no
meio. **As onze linhas iguais ao default podem sair**, e as quatro que restam
ficam visíveis.

### O `skipLevelOfDetail` está ajudando

Medido no Silo, mesma câmera, SSE 16:

| conjunto | tiles | triângulos | VRAM |
|---|---|---|---|
| EBGeo hoje | **92** | 481.173 | **40,5 MiB** |
| só os defaults do Cesium | 109 | 481.173 | 45,2 MiB |

**Mesma geometria visível com 17 tiles a menos e 4,7 MiB a menos.** O
`skipLevelOfDetail` pula os níveis intermediários, então o mesmo detalhe custa
menos residência. O Cesium desligou essa opção por padrão na 1.67 por causa do
artefato de ancestral aparecendo através enquanto os filhos carregam, e esse
artefato é o preço: **é ele que precisa ser julgado na tela**, não o número.

### Os dois `dynamicScreenSpaceError` continuam sem medida

`Density` 13,9× maior e `Factor` 12× menor que o padrão. Os dois valores vêm de
um exemplo do Cesium para tileset de cidade visto do horizonte, e a própria
documentação diz que a opção serve "for street-level horizon views". Um modelo
isolado, visto de fora, não tem horizonte. **Não medi se ajudam, atrapalham ou
são inertes aqui**, e a medida travou pelo mesmo estrangulamento de aba descrito
acima.

**`skipLevelOfDetail: true` muda tudo, e por isso uma medida sem ele mente.**
Medi o SSE duas vezes, e a diferença entre as duas foi só essa opção:

| medida | SSE | tiles |
|---|---|---|
| sem as opções do EBGeo (Ponte de Quatis) | 2 | 6.076 |
| **com** as opções do EBGeo (Silo) | 1 | **91** |

O `skipLevelOfDetail` pula os níveis intermediários da árvore, então o SSE
agressivo custa muito menos do que custaria sem ele. **A conclusão que eu tinha
tirado antes, de que trocar o SSE renderia 33x, veio da medida sem as opções e
está errada.** Com o conjunto real do EBGeo, no Silo:

| SSE | tiles | VRAM |
|---|---|---|
| 1 (o que o config publica) | 91 | 40,3 MiB |
| 16 | 8 | 1,1 MiB |

Ainda é 11x em tiles e 37x em VRAM, mas com 8 tiles o modelo fica grosseiro: aqui
a escolha é de qualidade e tem de ser julgada na tela, não na tabela.

Quem usa SSE 1 hoje: **6 dos 97 tilesets do config de produção**, todos do DJI
Terra (`esa`, `7bib`, `beira_rio`, `barragem_faxinal_soturno`,
`silo_dona_francisca`, `expoex_2026`). Os outros 91 usam o default de 16.

## Draco contra meshopt: o que fechou e o que não

**Fechou, e é estável:**

| | Draco | meshopt |
|---|---|---|
| disco (Silo, 1.554 tiles) | 338,3 MiB | **460,1 MiB** (+36,0%) |
| VRAM de geometria | 19,9 MiB | **31,2 MiB** (+56,8%) |
| VRAM de textura | 20,3 MiB | 20,3 MiB (igual) |
| tiles e triângulos | 91 / 481.173 | 91 / 481.179 |
| codec puro (Node) | 3,45 M vért/s | **16,19 M vért/s** |

**Não fechou:** o tempo de carga no cliente. Quatro rodadas alternadas deram
61,4 s e 81,5 s para Draco, e 19,7 s e **83,6 s** para meshopt. Duas medidas do
mesmo parâmetro que discordam por 4x indicam defeito no instrumento, e este é
conhecido: **com a aba em segundo plano o Chrome estrangula o `setTimeout`**, e o
relógio de parede passa a medir o estrangulamento. Trocar para tempo de CPU
dentro do `render()` também não resolve, porque o decode acontece num Web Worker,
fora dele.

**A medida que fecha isto é `bench/receita.html` com a aba em primeiro plano**,
sem trocar de janela durante a corrida. Enquanto ela não for feita, a escolha do
codec de geometria fica em aberto, e o Draco continua sendo o padrão por ser o
menor.

## O gargalo provável não está aqui

Levantado na pesquisa de fontes primárias, e é o achado que reordena a lista:

**O CesiumJS decodifica Draco numa thread só, e KTX2 em outra.** Um
`TaskProcessor` guarda **um** `_worker`. `DracoLoader` cria uma instância;
`KTX2Transcoder` cria outra. O `_maxDecodingConcurrency` que parece concorrência
é o tamanho da **fila**, não o número de workers.

Isso explica por que subir a concorrência de rede do Cesium rende pouco, e o
próprio time diz isso: "Raising this value did not result in performance gains
due to bottlenecks in other places in the pipeline"
([issue #11627](https://github.com/CesiumGS/cesium/issues/11627)).

**Consequência para nós:** o serviço entrega 3.645 tiles por segundo, e um
navegador com uma thread de Draco não consome isso. Afinar pragma do SQLite antes
de medir o cliente é otimizar o lado que sobra.

## A próxima medida, nesta ordem

1. **Onde o tempo vai, no cliente.** Instrumentar com `performance.mark` em torno
   do decode e comparar com o tempo de rede, numa trilha de câmera repetível. Se
   o decode domina, todo o resto é ruído.
2. **`mmap_size` num modelo grande.** O `ponte-quatis` tem 294 MiB e cabe no cache
   do sistema; num de 10 GiB o mmap decide. Rodar `npm run bench` contra o maior
   modelo importado.
3. **`maximumRequestsPerServer` do Cesium**, hoje 18 por padrão. Duas fontes do
   mesmo time discordam sobre subir: uma diz que não rendeu, outra diz que já viu
   ganho com 50. Discordância entre duas medidas do mesmo parâmetro é sinal de
   dependência de contexto, então o número tem de sair da nossa máquina.

## Números do cliente que valem conferir

Do código-fonte do CesiumJS, não da documentação publicada:

| opção | padrão |
|---|---|
| `maximumScreenSpaceError` | 16 |
| `cacheBytes` | 536.870.912 |
| `maximumCacheOverflowBytes` | 536.870.912 |
| `maximumRequests` | 50 |
| `maximumRequestsPerServer` | 18 (era 6 até a 1.113) |
| `foveatedConeSize` | **0,1** |

O `foveatedConeSize` merece nota: a documentação pública da Cesium publica 0,3, e
o construtor atribui 0,1. Quem citar 0,3 tirou da doc errada.

**`cacheBytes` conta memória de GPU, e não bytes de rede.** Dimensioná-lo pelo
tamanho do modelo em disco é erro de unidade. O número a usar é o
`tileset.totalMemoryUsageInBytes` lido em execução.

## O que foi descartado, e por quê

| descartado | motivo |
|---|---|
| `skipLevelOfDetail: true` | injeta o artefato de ancestral aparecendo através; foi desligado por padrão na 1.67 por isso |
| calibrar `dynamicScreenSpaceError` | a documentação diz "for street-level horizon views"; um modelo visto de fora não tem horizonte |
| domain sharding | obsoleto sob HTTP/2, e o `serverKey` do Cesium é `host:port`: sharding paga DNS e handshake e quebra a multiplexação |
| mais workers de decode por configuração | o Cesium não expõe; exigiria múltiplas instâncias de `TaskProcessor`, ou seja, um fork |
| comprimir `.glb` no servidor | Draco e ETC1S já não cedem ao gzip, e custaria CPU por tile |

## Como não medir errado

- **Nunca com o serviço de desenvolvimento e a bancada na mesma máquina sem
  reconhecer isso.** Os dois disputam CPU, e a latência que aparece não é a que o
  cliente teria.
- **Nunca sem aquecer.** A primeira leitura de cada página paga o disco, e o LRU
  começa vazio: a rodada inicial mede abertura de banco, não regime.
- **Nunca a primeira medida sozinha.** Toda diferença abaixo da dispersão das
  rodadas é a rodada que calhou de correr sozinha.
- **Sempre releia o valor efetivo, não o que foi pedido.** O SQLite recusa
  `journal_mode = OFF` nesta situação e devolve `delete` sem reclamar, e nós já
  documentamos uma otimização que nunca aconteceu por causa disso.
