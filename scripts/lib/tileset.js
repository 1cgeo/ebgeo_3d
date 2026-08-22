/**
 * @module scripts/lib/tileset
 * @description Reescrita dos tileset.json na conversao de 1.0 para 1.1.
 *
 * Tres mudancas, e nenhuma delas e cosmetica:
 *
 * 1. `asset.version` passa a "1.1". Sete modelos do acervo declaram "0.0", que
 *    o esquema nao admite (saida do DJI Terra). O Cesium tolera hoje; um
 *    validador ou outro cliente nao precisa tolerar.
 *
 * 2. Toda `uri` que termina em .b3dm passa a .glb, porque o conteudo mudou de
 *    container. Uri esquecida vira 404 em cima de um tile que existe.
 *
 * 3. Toda `uri` de conteudo ganha `?v=<token>`. Este e o ponto que mais custa se
 *    faltar: o tile e servido com `immutable` de um ano, entao sem o token uma
 *    reimportacao trocaria os bytes sem trocar a URL, e o navegador que ja
 *    visitou o modelo passaria o ano compondo tile velho dentro da arvore nova,
 *    sem um erro no console. O ebgeo_360 ja pagou exatamente esse defeito.
 *
 * `asset.gltfUpAxis` SAI. Ele nunca existiu no esquema de 1.1, e o glTF ja e
 * Y-up por definicao; o Cesium aplica a rotacao sozinho.
 */

/**
 * Extensoes que sao conteudo servido, e por isso levam o token.
 * O tileset.json externo entra na lista: ele tambem e buscado por URL e tambem
 * fica velho numa reimportacao.
 */
const CONTEUDO = /\.(b3dm|glb|gltf|pnts|i3dm|cmpt|json|subtree)$/i;

/**
 * Fator de correcao do geometricError por motor de geracao.
 *
 * O DJI TERRA SUBESTIMA O ERRO GEOMETRICO DOS SEUS TILES. Medido no Silo contra
 * a Ponte de Quatis, com o modelo do DJI sendo 1,65x MAIOR:
 *
 *                     mediana   maximo
 *   Agisoft Metashape   0,226    57,768
 *   DJI Terra           0,048     6,193
 *
 * O efeito no CesiumJS: o erro de tela de cada tile fica pequeno demais, o
 * refinamento para cedo e o modelo aparece grosseiro. O contorno que a DGEO usa
 * hoje e publicar `maximumScreenSpaceError: 1` nos 6 modelos do DJI, contra o
 * 16 dos outros 91, e isso e uma pegadinha que o operador tem de lembrar modelo
 * a modelo.
 *
 * Escalar o geometricError por 16 na conversao e MATEMATICAMENTE EQUIVALENTE a
 * dividir o SSE por 16, e move a correcao do config para o dado. Medido, e a
 * igualdade e exata:
 *
 *   original,      SSE  1 -> 91 tiles, 481.173 triangulos, 40,3 MiB
 *   escalado x16,  SSE 16 -> 91 tiles, 481.173 triangulos, 40,3 MiB
 *
 * O 1e10 que o DJI grava no root de cada tileset externo NAO e a causa: trocar
 * so ele nao mudou nada (8 tiles antes e depois, com SSE 16). Ele fica de fora
 * da escala, porque ja e o "sempre refine" e multiplicar nao muda isso.
 */
export const ESCALA_GE = {
  'DJI Terra': 16,
};

/**
 * Teto padrao de resolucao de textura, em pixels do lado maior.
 *
 * LIGADO EM 512 POR DECISAO DO CHEFE, em 2026-08-22, depois de ele julgar dois
 * pares na tela e dizer que a diferenca nao e perceptivel. Antes disso o teto
 * vinha desligado, porque ele TROCA qualidade por tamanho e a troca e do dono
 * do acervo, nao do roteiro.
 *
 * O QUE A TROCA COMPRA, medido em quatro modelos convertidos dos dois lados:
 *
 *   modelo      motor       sem teto     com teto    conversao
 *   Beira-Rio   DJI         1.556 MiB    808 MiB     880 s -> 353 s
 *   Silo        DJI           338 MiB    214 MiB     245 s -> 118 s
 *   Aerodromo   Metashape     821 MiB    586 MiB     369 s -> 278 s
 *   Ponte       Metashape     294 MiB    250 MiB
 *
 * SEM O TETO O ACERVO CRESCE. Nos quatro casos a saida ficou MAIOR que a
 * origem (razao 1,13 a 1,17), porque o ETC1S e menos compacto que o JPEG que a
 * origem usa. Com o teto os quatro encolhem. Extrapolado para os 114 modelos:
 * 106 GiB sem teto contra cerca de 75 GiB com ele.
 *
 * E ele compra VRAM tambem: no aerodromo a textura em GPU caiu de 12,8 para
 * 7,3 MiB, com os MESMOS 151 tiles e 194.231 triangulos.
 *
 * Para desligar num modelo: `--max-textura 0`.
 */
export const MAX_TEXTURA_PADRAO = 512;

/**
 * Teto por MOTOR de geracao, para o caso de um deles precisar de outro valor.
 *
 * Vazio significa "o padrao vale para todos". A tabela fica porque a
 * distribuicao NAO e uniforme, e um dia pode pedir tratamento separado: medido
 * no acervo, o teto corta 64% dos pixels no DJI Terra (que exporta 1024x1024) e
 * 25% no Metashape (que exporta 256 a 768).
 */
export const MAX_TEXTURA = {
};
/** Acima disto o valor e o "sempre refine" do DJI, e nao um erro de verdade. */
const GE_ABSURDO = 1e9;

/**
 * @typedef {object} Resultado
 * @property {object} json      - O tileset reescrito
 * @property {string[]} uris    - Chaves referenciadas, ja normalizadas e sem query
 * @property {number} trocadas  - Quantas uris mudaram de .b3dm para .glb
 * @property {number} escalados - Quantos geometricError foram escalados
 * @property {boolean} mudou
 */

/**
 * Reescreve um tileset.json.
 *
 * @param {object} json - O tileset ja parseado
 * @param {string} token - Token de geracao do modelo
 * @param {object} [opcoes]
 * @param {boolean} [opcoes.converterB3dm] - true quando os tiles viraram .glb
 * @param {number} [opcoes.escalaGe] - fator aplicado a todo geometricError finito
 * @returns {Resultado}
 */
export function reescreveTileset(json, token, { converterB3dm = true, escalaGe = 1 } = {}) {
  let mudou = false;
  let trocadas = 0;
  let escalados = 0;
  const uris = [];

  /** Escala um geometricError, deixando o "sempre refine" do DJI intacto. */
  function escala(t) {
    if (escalaGe === 1) return;
    const g = t.geometricError;
    if (typeof g === 'number' && g < GE_ABSURDO) {
      t.geometricError = g * escalaGe;
      escalados++;
      mudou = true;
    }
  }

  if (json.asset) {
    if (json.asset.version !== '1.1') {
      json.asset.version = '1.1';
      mudou = true;
    }
    if ('gltfUpAxis' in json.asset) {
      delete json.asset.gltfUpAxis;
      mudou = true;
    }
  } else {
    json.asset = { version: '1.1' };
    mudou = true;
  }

  function trataUri(c) {
    if (!c || typeof c.uri !== 'string') return;
    let uri = c.uri.split('?')[0];

    // URL ABSOLUTA SAI PRIMEIRO, antes da troca de extensao. Um tileset que
    // referencia outro servidor nao passou por esta conversao: trocar o .b3dm
    // dele por .glb apontaria para um arquivo que so existe aqui.
    if (/^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.startsWith('//')) {
      c.uri = uri;
      return;
    }

    if (converterB3dm && /\.b3dm$/i.test(uri)) {
      uri = uri.replace(/\.b3dm$/i, '.glb');
      trocadas++;
      mudou = true;
    }
    uris.push(uri);
    if (CONTEUDO.test(uri)) {
      c.uri = `${uri}?v=${token}`;
      mudou = true;
    } else {
      c.uri = uri;
    }
  }

  function percorre(tile) {
    if (!tile || typeof tile !== 'object') return;
    escala(tile);

    // TILING IMPLICITO SAI ANTES DE QUALQUER TROCA. Ele nao lista tile por tile:
    // os templates de subtree e de conteudo levam {level}/{x}/{y}, e a
    // substituicao acontece no CLIENTE. Um `?v=` colado no template sairia no
    // lugar errado da URL montada, e a troca de extensao mentiria sobre um
    // arquivo que nem foi gerado ainda.
    // Nenhum modelo do acervo usa implicito hoje; a guarda existe para a
    // conversao nao adulterar um que use.
    if (tile.implicitTiling) return;

    trataUri(tile.content);
    if (Array.isArray(tile.contents)) tile.contents.forEach(trataUri);
    if (Array.isArray(tile.children)) tile.children.forEach(percorre);
  }

  escala(json);          // o geometricError do documento, fora do root
  percorre(json.root);
  return { json, uris, trocadas, escalados, mudou };
}

/**
 * Extrai o ponto de navegacao (lon, lat, altura) de um tileset de raiz.
 *
 * Duas fontes, nesta ordem:
 *   1. `properties.Longitude/Latitude/Height`, que o Metashape grava. Os angulos
 *      vem em RADIANOS, e nao em graus: o campo nao diz, e ler como grau poe o
 *      modelo do outro lado do planeta.
 *   2. `boundingVolume.region`, que tambem e em radianos por definicao do
 *      esquema.
 *
 * Devolve null quando nenhuma das duas existe (caso do `boundingVolume.box`
 * puro, que so faz sentido com o `transform` do proprio tile). Nesse caso o
 * ponto de navegacao entra a mao no catalogo.
 *
 * @param {object} json
 * @returns {{lon:number, lat:number, height:number}|null}
 */
export function pontoDeNavegacao(json) {
  const grau = (rad) => (rad * 180) / Math.PI;

  const p = json.properties;
  if (p && p.Longitude && p.Latitude) {
    const lon = (p.Longitude.maximum + p.Longitude.minimum) / 2;
    const lat = (p.Latitude.maximum + p.Latitude.minimum) / 2;
    const h = p.Height ? (p.Height.maximum + p.Height.minimum) / 2 : 0;
    return { lon: grau(lon), lat: grau(lat), height: h };
  }

  const bv = json.root && json.root.boundingVolume;
  if (bv && Array.isArray(bv.region) && bv.region.length === 6) {
    const [oeste, sul, leste, norte, minAlt, maxAlt] = bv.region;
    return {
      lon: grau((oeste + leste) / 2),
      lat: grau((sul + norte) / 2),
      height: (minAlt + maxAlt) / 2,
    };
  }

  return null;
}

/* ===================================================================== */

const RAIO_EQ = 6378137.0;
const ACHATAMENTO = 1 / 298.257223563;
const E2 = ACHATAMENTO * (2 - ACHATAMENTO);

/** Converte ECEF para (lon, lat, altura elipsoidal). Bowring iterado. */
function paraGeodesico(x, y, z) {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2));
  let h = 0;
  for (let i = 0; i < 12; i++) {
    const n = RAIO_EQ / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
    h = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - (E2 * n) / (n + h)));
  }
  const grau = 180 / Math.PI;
  return { lon: lon * grau, lat: lat * grau, h };
}

/** Produto de duas matrizes 4x4 column-major, a forma que o 3D Tiles grava. */
function multiplica4(a, b) {
  const r = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let l = 0; l < 4; l++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + l] * b[c * 4 + k];
      r[c * 4 + l] = s;
    }
  }
  return r;
}

/** Aplica a matriz a um ponto. */
function transforma(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** Resolve uma uri relativa contra o diretorio do tileset que a cita. */
function resolveChave(base, uri) {
  const partes = [];
  for (const p of `${base ? `${base}/` : ''}${uri}`.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') { partes.pop(); continue; }
    partes.push(p);
  }
  return partes.join('/');
}

/**
 * @typedef {object} Envelope
 * @property {number} lon        - centro, em graus
 * @property {number} lat        - centro, em graus
 * @property {number} hMin       - menor altura elipsoidal do conteudo
 * @property {number} hChao      - mediana, que e a estimativa do chao
 * @property {number} hMax
 * @property {number} raio       - meia-diagonal horizontal, em metros
 * @property {number} amostras   - quantos cantos de tile entraram na conta
 */

/**
 * Mede o envelope geodesico de um modelo percorrendo TODA a arvore de tilesets.
 *
 * Existe porque `pontoDeNavegacao` devolve null quando o tileset traz
 * `boundingVolume.box` puro, sem `properties` e sem `region`, que e o caso do
 * DJI Terra. Ali o ponto entrava a mao no catalogo, e foi exatamente o que
 * errou: o Silo entrou 3,6 km ao sul do lugar dele.
 *
 * O CUIDADO QUE FAZ A CONTA VALER: o box de um tile e local ao `transform`
 * ACUMULADO da raiz ate ele, e nao ECEF. Ler o box direto poe o modelo no meio
 * do Atlantico, com latitude perto de zero. Cada tileset externo reentra com o
 * transform do tile que o referencia ja multiplicado.
 *
 * `hChao` e a MEDIANA das alturas dos cantos, e nao o minimo: o minimo e o canto
 * de uma caixa folgada, e afunda o modelo. Medido no Silo, minimo 39,5 m contra
 * mediana 62,3 m; na Ponte, 292,6 m contra 343,2 m.
 *
 * @param {Map<string,object>|object} docs - chave normalizada -> tileset ja parseado
 * @param {string} [raiz] - chave do tileset de entrada
 * @returns {Envelope|null}
 */
export function envelopeGeodesico(docs, raiz = 'tileset.json') {
  const mapa = docs instanceof Map ? docs : new Map(Object.entries(docs));
  const entrada = mapa.get(raiz);
  if (!entrada || !entrada.root) return null;

  const lons = [];
  const lats = [];
  const alturas = [];
  const visitados = new Set([raiz]);

  function anda(tile, matriz, base) {
    if (!tile || typeof tile !== 'object') return;
    const m = Array.isArray(tile.transform) && tile.transform.length === 16
      ? multiplica4(matriz, tile.transform)
      : matriz;

    const conteudos = [];
    if (tile.content) conteudos.push(tile.content);
    if (Array.isArray(tile.contents)) conteudos.push(...tile.contents);

    let temGeometria = false;
    for (const c of conteudos) {
      const uri = String(c && c.uri ? c.uri : '').split('?')[0];
      if (!uri) continue;
      if (uri.endsWith('.json')) {
        const alvo = resolveChave(base, uri);
        const externo = mapa.get(alvo);
        if (externo && externo.root && !visitados.has(alvo)) {
          visitados.add(alvo);
          const corte = alvo.lastIndexOf('/');
          anda(externo.root, m, corte < 0 ? '' : alvo.slice(0, corte));
        }
      } else if (!uri.endsWith('.subtree')) {
        temGeometria = true;
      }
    }

    const box = tile.boundingVolume && tile.boundingVolume.box;
    if (temGeometria && Array.isArray(box) && box.length === 12) {
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          for (const sz of [-1, 1]) {
            const v = transforma(m,
              box[0] + sx * box[3] + sy * box[6] + sz * box[9],
              box[1] + sx * box[4] + sy * box[7] + sz * box[10],
              box[2] + sx * box[5] + sy * box[8] + sz * box[11]);
            const g = paraGeodesico(v[0], v[1], v[2]);
            lons.push(g.lon); lats.push(g.lat); alturas.push(g.h);
          }
        }
      }
    }

    if (Array.isArray(tile.children)) for (const f of tile.children) anda(f, m, base);
  }

  const corte = raiz.lastIndexOf('/');
  anda(entrada.root, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    corte < 0 ? '' : raiz.slice(0, corte));

  if (!alturas.length) return null;
  alturas.sort((a, b) => a - b);
  // REDUCE, E NAO `Math.min(...lons)`: a Ponte de Quatis rende 60.008 cantos, e
  // o spread de um array desse tamanho estoura a pilha de argumentos.
  const menor = (v) => v.reduce((a, b) => (b < a ? b : a), Infinity);
  const maior = (v) => v.reduce((a, b) => (b > a ? b : a), -Infinity);
  const lonMin = menor(lons); const lonMax = maior(lons);
  const latMin = menor(lats); const latMax = maior(lats);
  const lat = (latMin + latMax) / 2;
  const metroPorGrau = 111320;
  const largura = (lonMax - lonMin) * metroPorGrau * Math.cos((lat * Math.PI) / 180);
  const altura = (latMax - latMin) * metroPorGrau;
  return {
    lon: (lonMin + lonMax) / 2,
    lat,
    hMin: alturas[0],
    hChao: alturas[Math.floor(alturas.length / 2)],
    hMax: alturas[alturas.length - 1],
    raio: Math.hypot(largura, altura) / 2,
    amostras: alturas.length,
  };
}
