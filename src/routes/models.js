/**
 * @module routes/models
 * @description Catalogo dos modelos: a lista e a ficha de um modelo.
 *
 * A LISTA JA SAI NO FORMATO QUE O ebgeo_web ESPERA no array `config.tilesets`,
 * campo a campo. A alternativa seria o web traduzir a resposta, e ai o contrato
 * viveria em dois lugares: uma chave nova exigiria mexer nos dois repositorios,
 * e esquecer um deles some com o campo sem erro nenhum.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { listModels, getModel, listImports } from '../db/queries.js';
import { setCatalogCacheHeaders } from '../middleware/cache.js';
import config from '../config.js';

/**
 * Segmento das previas, RELATIVO A BASE DA API, e nao ao host.
 *
 * Sem o `/api/v1`, exatamente como o `THUMBNAILS_SEGMENT` do ebgeo_360. O
 * consumidor concatena com a base que so ele conhece, e essa base ja traz o
 * `/api/v1` em desenvolvimento e o prefixo do proxy em producao. Embutir o
 * `/api/v1` aqui daria `/api/v1/api/v1/assets/...` no desenvolvimento.
 */
const ASSETS_SEGMENT = '/assets';

/**
 * A previa DERIVA DO SLUG, e nao de uma coluna do catalogo.
 *
 * E como o ebgeo_360 faz (`/thumbnails/{slug}.webp`), e evita o estado
 * duplicado: com coluna, publicar uma miniatura obriga a copiar o arquivo E a
 * gravar o caminho, e esquecer o segundo passo some com a imagem sem erro.
 * Derivando, basta pôr o arquivo com o nome do modelo.
 *
 * O `existsSync` e o que separa "nao ha previa" de "ha previa quebrada": sem
 * ele, todo modelo publicaria uma URL, e o card do catalogo mostraria imagem
 * partida em vez de cair para o icone padrao.
 */
function previa(id, extensao) {
  const arquivo = `${id}.${extensao}`;
  return existsSync(join(config.assetsDir, arquivo)) ? `${ASSETS_SEGMENT}/${arquivo}` : undefined;
}

/**
 * Converte a linha do banco para a entrada de catalogo do EBGeo.
 * @param {object} m
 * @param {string} base - Prefixo publico das URLs (ex.: '/ebgeo_3d')
 * @returns {object}
 */
function paraCatalogo(m, base) {
  const url = `${base}/api/v1/models/${m.id}/tileset.json`;
  const saida = {
    id: m.id,
    name: m.name,
    type: '3dtiles',
    url,
    description: m.description ?? undefined,
    local: m.local ?? undefined,
    data_captura: m.captured_at ?? undefined,
    heightOffset: m.height_offset ?? 0,
    // Altura elipsoidal do chao, medida. O cliente sem terreno usa
    // heightOffset = -groundHeight; ver docs/operacao.md.
    groundHeight: m.ground_height ?? undefined,
    // Ponto mais baixo do modelo. E ele que decide o heightOffset de um cliente
    // sem terreno: pela mediana o modelo afunda e o globo o corta.
    minHeight: m.min_height ?? undefined,
  };
  if (m.keywords) {
    try { saida.keywords = JSON.parse(m.keywords); } catch { /* keywords invalido: omite */ }
  }
  if (m.lon != null && m.lat != null) {
    saida.locate = { lon: m.lon, lat: m.lat, height: m.height ?? 1000 };
  }
  // So publica o parametro quando ele foge do padrao do Cesium (16). Emitir 16
  // em toda entrada convidaria a tratar o default como decisao do modelo.
  if (m.max_sse != null && m.max_sse !== 16) saida.maximumScreenSpaceError = m.max_sse;

  // A previa sai RELATIVA a base, igual ao previewThumbnail do 360: o consumidor
  // concatena com a propria base do servico, que so ele conhece.
  const thumb = m.preview_thumb || previa(m.id, 'webp');
  const video = m.preview_video || previa(m.id, 'webm');
  if (thumb) saida.previewThumbnail = `${base}${thumb}`;
  if (video) saida.previewVideo = `${base}${video}`;

  saida.formato = {
    tilesVersion: m.tiles_version,
    geometry: m.geometry_codec,
    texture: m.texture_codec,
    textureQuality: m.texture_quality,
    tiles: m.tile_count,
    bytes: m.total_bytes,
    buildToken: m.build_token,
    builtAt: m.built_at,
    source: m.source,
  };
  return saida;
}

export default async function modelRoutes(fastify) {
  // GET /api/v1/models: o catalogo inteiro
  //
  // `?base=` existe porque em producao o servico vive atras de um prefixo
  // (`/ebgeo_3d`) que ele NAO enxerga: o proxy recebe `/ebgeo_3d/...` e repassa
  // `/api/v1/...`. Publicar uma URL absoluta montada aqui daria um caminho que
  // responde 404 do lado de fora. O mesmo defeito que o config.js do ebgeo_web
  // documenta na base do 360.
  fastify.get('/api/v1/models', async (request, reply) => {
    const base = typeof request.query.base === 'string' ? request.query.base.replace(/\/+$/, '') : '';
    setCatalogCacheHeaders(reply);
    const modelos = listModels();
    return {
      count: modelos.length,
      tilesets: modelos.map((m) => paraCatalogo(m, base)),
    };
  });

  // GET /api/v1/models/:id.json: a ficha de um modelo
  //
  // O `.json` no fim NAO e enfeite. Sem ele a rota seria `/api/v1/models/:id`, e
  // o curinga de tiles.js (`/api/v1/models/:id/*`) e irmao dela: a ficha e o
  // conteudo passariam a disputar o mesmo espaco de nomes, e um modelo chamado
  // "tileset.json" viraria ambiguidade. Com a extensao, os dois nunca colidem.
  fastify.get('/api/v1/models/:id.json', async (request, reply) => {
    const id = request.params.id;
    const m = getModel(id);
    if (!m) {
      reply.code(404);
      return { error: 'Model not found' };
    }
    const base = typeof request.query.base === 'string' ? request.query.base.replace(/\/+$/, '') : '';
    setCatalogCacheHeaders(reply);
    return {
      ...paraCatalogo(m, base),
      importacoes: listImports(id, 3),
    };
  });
}
