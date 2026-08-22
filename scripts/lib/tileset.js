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
