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
