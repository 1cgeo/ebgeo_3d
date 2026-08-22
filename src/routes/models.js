/**
 * @module routes/models
 * @description Catalogo dos modelos: a lista e a ficha de um modelo.
 *
 * A LISTA JA SAI NO FORMATO QUE O ebgeo_web ESPERA no array `config.tilesets`,
 * campo a campo. A alternativa seria o web traduzir a resposta, e ai o contrato
 * viveria em dois lugares: uma chave nova exigiria mexer nos dois repositorios,
 * e esquecer um deles some com o campo sem erro nenhum.
 */

import { listModels, getModel, listImports } from '../db/queries.js';
import { setCatalogCacheHeaders } from '../middleware/cache.js';

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
    previewVideo: m.preview_video ?? undefined,
    previewThumbnail: m.preview_thumb ?? undefined,
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
