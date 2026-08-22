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

## O CesiumJS, a terceira camada

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

### O instrumento, consertado em 2026-08-22

Nada abaixo valeria sem isto. A bancada antiga mediu a MESMA variante em 19,7 s
e em 83,6 s. A causa ficou provada: numa aba que o Chrome considera `hidden`, o
`requestAnimationFrame` **não dispara nenhum quadro**. Um laço que espera um
segundo de rAF ali nunca termina, e o CDP estoura em 45 s. E `setTimeout` não
salva: numa aba oculta ele cai para cerca de um disparo por segundo.

O agendador que escapa dos dois é o `MessageChannel`. Medido na mesma aba
oculta: **107.599 ticks em um segundo, contra zero quadros de rAF**. Com ele a
`bench/cesium.html` chama `scene.render()` explicitamente.

Reprodutibilidade depois do conserto, mesmo caso cinco vezes seguidas:
1637, 1145, 1070, 1095, 1057 ms. A primeira é o aquecimento, e as outras variam 8%.

A bancada **reprova a si mesma**: se a cadência ociosa do agendador passar de
5 ms, a medida sai marcada INVALIDA e não entra no resumo.

E ela captura a tela sozinha. `Page.captureScreenshot` do CDP também estoura com
a aba oculta, mas o framebuffer do WebGL existe: `canvas.toDataURL` o lê, desde
que o Viewer suba com `preserveDrawingBuffer`. As imagens vão para
`bench/capturas/`. **A contagem de tile diz quanto custou, e só a imagem diz se
ficou bom.**

```bash
EBGEO3D_CESIUM_DIR=<ebgeo_web>/public/vendors/cesium npm run bench:cliente
# depois, no console da pagina:
#   compara([{rotulo, modelo, extras, dist, pitch, frio, req}], rodadas)
#   mostra(modelo, extras, dist, pitch, nomeDaCaptura)
```

`dist` é MULTIPLICADOR do raio medido do modelo, e não metros: o mesmo caso
enquadra igual em modelos de tamanhos diferentes.

### O `skipLevelOfDetail` está ajudando, e a imagem é a mesma

Medido com o instrumento novo, 3 rodadas intercaladas, SSE 16, `dist` 0,9:

| modelo | conjunto | tiles | triângulos | VRAM | ms |
|---|---|---|---|---|---|
| Silo | EBGeo hoje | **153** | 853.953 | **67,3 MiB** | **983** |
| Silo | sem `skipLevelOfDetail` | 223 | 930.081 | 92,1 MiB | 1222 |
| Ponte | EBGeo hoje | **18** | 27.884 | **1,0 MiB** | **414** |
| Ponte | sem `skipLevelOfDetail` | 61 | 80.706 | 3,9 MiB | 511 |

31% a 70% menos tiles, 27% a 74% menos VRAM, 19% menos tempo. O artefato de
ancestral aparecendo através fez o Cesium desligar a opção por padrão na 1.67.
Ele **foi julgado na tela**, e `bench/capturas/silo-sse16.jpg` contra
`silo-sem-skiplod.jpg` são indistinguíveis. **Mantenha ligado.**

### Os três `dynamicScreenSpaceError` são INERTES aqui

Medidos em três vistas, 3 a 4 rodadas cada, ligado com os valores da DGEO,
desligado, e com os valores padrão do Cesium:

| vista | tiles | triângulos | VRAM |
|---|---|---|---|
| de cima (pitch −35°) | 153 / 153 / 153 | idênticos | 67,3 / 67,3 / 67,3 |
| rasante (pitch −6°) | 46 / 46 / 46 | idênticos | 4,0 / 4,0 / 4,0 |
| nível do solo (pitch −2°, 400 m) | 218 / 221 / 221 | 1,30 M / 1,34 M / 1,33 M | 101,2 / 102,7 / 102,1 |

Números **iguais dígito a dígito** nas duas primeiras. Na terceira o efeito
chega a 3% dos triângulos, e o tempo com a opção ligada foi PIOR, dentro do
ruído.

A explicação está no fonte, em `Cesium3DTileset.js:updateDynamicScreenSpaceError`:

```js
const t = clamp((height - heightClose) / (heightFar - heightClose), 0, 1);
horizonFactor = horizonFactor * (1.0 - t);
tileset._dynamicScreenSpaceErrorComputedDensity = density * horizonFactor;
```

`heightFar` é a altura MÁXIMA do tileset. Com a câmera acima dela, `t` vale 1, o
`horizonFactor` zera e a densidade computada vira 0: a otimização não age. Um
modelo de fotogrametria visto de fora nunca põe a câmera abaixo do próprio topo.

**As três linhas podem sair do `map_3d.js`.** Elas não fazem nada neste acervo, e
sustentam a impressão de que há uma decisão medida por trás.

### O SSE é a alavanca dominante, e nenhuma outra chega perto

Mesma câmera, 3 rodadas:

| modelo | SSE | tiles | triângulos | VRAM | ms | ms por render |
|---|---|---|---|---|---|---|
| Silo | 8 | 247 | 1.605.799 | 116,6 | 1516 | 7,85 |
| Silo | **16** | **153** | **853.953** | **67,3** | **983** | **4,26** |
| Silo | 32 | 83 | 447.463 | 36,7 | 526 | 2,15 |
| Ponte | 8 | 41 | 83.087 | 2,7 | 481 | 1,46 |
| Ponte | **16** | **18** | **27.884** | **1,0** | **414** | **0,79** |
| Ponte | 32 | 11 | 12.114 | 0,5 | 165 | 0,54 |

Dobrar o SSE corta o trabalho quase pela metade. Nenhuma outra opção do Cesium
chegou a 30%.

Julgado na tela: `silo-sse32.jpg` e `silo-sse16.jpg` são quase indistinguíveis
NESTA distância. Isso não autoriza subir o padrão: numa vista próxima o 32
degrada, e a distância de trabalho de cada operador é outra. Fica como
possibilidade medida, e não como recomendação.

### `maximumRequestsPerServer`: 18 basta, 50 não rende

A discordância entre duas fontes do time está resolvida para esta máquina.
Silo, SSE 16, 4 rodadas, com o cache do navegador FRIO. A bancada acrescenta um
parâmetro único à URL do tileset, e o Cesium o propaga a todo tile derivado.

| caso | ms | amplitude |
|---|---|---|
| frio, 6 por servidor | 1172 | 538 |
| frio, **18** (padrão) | **934** | 191 |
| frio, 50 | 945 | 37 |
| quente, 18 | 921 | 40 |

Subir de 18 para 50 **não rende nada**. Cair para 6 custa 25%.

E o mais importante: **cache frio e cache quente empatam** (934 contra 921). Em
`localhost` a rede não custa, e o que sobra é CPU de decode. Isto confirma a
leitura do chefe de que a máquina do cliente dói mais que a banda. E vale só
para `localhost`: numa rede lenta a medida tem de ser refeita.

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
mesmo parâmetro que discordam por 4× indicam defeito no instrumento. O defeito
foi achado e consertado em 2026-08-22: ver "O instrumento" acima. A bancada
`bench/cesium.html` já reproduz o mesmo caso com 8% de variação.

**A comparação em si continua por refazer** com o instrumento novo. O Draco
segue como padrão por ser o menor em disco e em VRAM, e por decisão do chefe.

## O gargalo provável não está aqui

Levantado na pesquisa de fontes primárias, e é o achado que reordena a lista:

**O CesiumJS decodifica Draco numa thread só, e KTX2 em outra.** Um
`TaskProcessor` guarda **um** `_worker`. `DracoLoader` cria uma instância;
`KTX2Transcoder` cria outra. O `_maxDecodingConcurrency` que parece concorrência
é o tamanho da **fila**, não o número de workers.

Isso explica por que subir a concorrência de rede do Cesium rende pouco. O
próprio time diz o mesmo no
[issue #11627](https://github.com/CesiumGS/cesium/issues/11627): subir o valor
não rendeu, por gargalo em outro ponto do fluxo.

**Isto agora está medido aqui, e confere:** 18 e 50 requisições por servidor
empatam, e cache frio empata com cache quente. Ver a seção do
`maximumRequestsPerServer` acima.

**Consequência para nós:** o serviço entrega 3.645 tiles por segundo, e um
navegador com uma thread de Draco não consome isso. Afinar pragma do SQLite antes
de medir o cliente é otimizar o lado que sobra.

## A camada de formato: a textura é o byte, e não o tempo

Amostra de 250 tiles por modelo, somando os `bufferView` de imagem contra o
resto:

| modelo | textura | geometria | textura é |
|---|---|---|---|
| Silo (DJI Terra) | 47,3 MiB | 8,1 MiB | **85%** |
| Ponte (Metashape) | 6,9 MiB | 1,7 MiB | **80%** |

E no acervo inteiro, medido em 114 modelos e 11.261 tiles amostrados da origem:
a mediana da fração de imagem por tile é **78%**.

Toda a discussão de Draco contra meshopt, e os bits de quantização, mexem nos
15% a 20% que sobram.

### O excesso de resolução é do DJI Terra, e não do acervo

| resolução | silo | ponte |
|---|---|---|
| 1024×1024 | 67,8% dos bytes de textura | 0% |
| 512×512 | 28,2% | 18,1% |
| 512×256 e 768×256 | — | 70,1% |

No acervo: **10,7% dos pixels passam de 512×512**, e eles se concentram em 7
modelos do DJI Terra que somam 11,2 GiB. Nos modelos do Metashape a fatia fica
abaixo de 22%, quase sempre abaixo de 14%.

### O que o teto de 512 compra, e o que não compra

O Silo foi reconvertido inteiro com `--max-textura 512` e medido lado a lado:

| | disco | conversão | VRAM longe | VRAM perto | ms longe | ms perto |
|---|---|---|---|---|---|---|
| 1024 (hoje) | 338,4 MiB | 245,4 s | 69,2 MiB | 45,0 MiB | 915 | 426 |
| 512 | **214,5 MiB** | **118,2 s** | **61,7 MiB** | **31,1 MiB** | 929 | 419 |
| diferença | −37% | 2,1× mais rápido | −11% | −31% | **nenhuma** | **nenhuma** |

Só a VRAM de textura: 37,6 para 30,1 MiB de longe, e 29,7 para 15,8 MiB de perto.

**O TEMPO NÃO MUDA, nem com o cache do navegador frio.** Isto refuta a hipótese
que abriu esta investigação: a textura é 85% do byte, mas não é o gargalo de
tempo. O teto compra disco e VRAM, e não velocidade.

E cobra. Julgue em `bench/capturas/silo-tex512-perto.jpg` contra
`silo-tex1024-perto.jpg`, com a câmera a cerca de 157 m. O 512 **amacia a telha
do galpão e apaga a divisão dos painéis solares**. De longe as duas são
indistinguíveis.

Por isso `MAX_TEXTURA` em `scripts/lib/tileset.js` **vem vazio**. Diferente da
escala do `geometricError`, que corrige um defeito da origem sem custo, o teto
troca qualidade por tamanho. Quem decide a troca é o chefe:
`--max-textura 512`.

## A camada SQLite: a ordem física, medida de duas formas

A hipótese: a importação insere na ordem em que varre o diretório de origem, e o
CesiumJS lê na ordem de travessia da árvore. Se as duas divergirem, cada tile
pedido cai numa página distante.

`node --expose-gc bench/ordem.js --modelo ponte-quatis` monta duas cópias do
mesmo modelo, com os mesmos pragmas e o mesmo conteúdo, mudando só a ordem de
inserção. Resultado: **empate, −0,4%**. E o próprio roteiro avisa por quê. O
modelo cabe folgado na memória do sistema, e o cache de página serve tudo. Ali
as duas ordens empatam por construção.

A medida que fecha não é de tempo, é de contagem. O offset acumulado por rowid
aproxima a posição física, porque o BLOB médio é dez vezes maior que a página:

| modelo | salto mediano na ordem de travessia | tamanho de um tile | razão | saltos abaixo de 1 MiB |
|---|---|---|---|---|
| Ponte (Metashape) | 0,09 MiB | 39 KiB | 2× | **98,9%** |
| Silo (DJI Terra) | 0,73 MiB | 219 KiB | 3× | **59,8%** |

**A ordem física do Metashape já é quase a de travessia**, porque a varredura do
diretório segue as pastas `Data/dNNN`. A do DJI dispersa: o p90 do salto é
23 MiB.

Reordenar custaria um passe de reescrita no fim da importação. Não rende nada
nesta máquina, e pode render no servidor de produção, que serve 104 GiB com
muito menos memória que isso. **Fica como hipótese com medida pendente lá**, e
não como mudança a fazer no escuro.

## A próxima medida, nesta ordem

1. **Onde o tempo vai, dentro do cliente.** Não é rede: frio e quente empatam. Não é
   resolução de textura: o teto não mudou o tempo. Não é o número de conexões:
   18 e 50 empatam. Sobram o decode Draco, a transcodificação KTX2 e a montagem
   da cena. `performance.mark` em torno de
   cada um, com o instrumento que agora funciona.
2. **A mesma bateria numa rede lenta de verdade.** Tudo acima foi medido em
   `localhost`, onde a banda não custa. O `maximumRequestsPerServer` e o teto de
   textura podem inverter de veredito ali.
3. **`mmap_size` num modelo grande.** O maior publicado tem 294 MiB e cabe no
   cache do sistema. Num de 10 GiB o mmap decide.
4. **A ordem física no servidor de produção**, onde o acervo não cabe na memória.

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
