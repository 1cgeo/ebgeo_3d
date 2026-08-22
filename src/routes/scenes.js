/**
 * @module routes/scenes
 * @description Catalogo das cenas navegaveis a pe (Gaussian Splatting).
 *
 * A SAIDA JA E O QUE O `config.firstPerson3d.scenes` DO ebgeo_web ESPERA, campo
 * a campo, pela mesma razao da rota de modelos: com o web traduzindo a resposta,
 * o contrato viveria em dois repositorios, e esquecer um deles some com o campo
 * sem erro nenhum.
 *
 * O ARQUIVO DA CENA NAO PASSA POR AQUI. Ele sai do `@fastify/static` montado em
 * `/api/v1/scenes/`, direto do disco. Esta rota so publica o metadado e o
 * `basePath` que enderaca a pasta.
 */

import { listScenes, getScene } from '../db/queries.js';
import { setCatalogCacheHeaders } from '../middleware/cache.js';

/**
 * Converte a linha do banco na entrada de cena do EBGeo.
 *
 * @param {object} c
 * @param {string} base - Prefixo publico das URLs (ex.: '/ebgeo_3d')
 * @returns {object}
 */
function paraCatalogo(c, base) {
  const saida = {
    id: c.id,
    name: c.name,
    // O basePath ENDERECA A PASTA, e todo o resto deriva dele no cliente:
    // `cena.sog`, `voxel/voxel-meta.json`, `voxel/voxel.bin`, `marcadores.json`,
    // `itens/`, `preview/preview.webm` e `preview/thumbnail.jpg`.
    //
    // Sao sete enderecos, e sete chances de errar um. O erro nao seria
    // barulhento: o splat carrega, o voxel-meta.json volta 404, e a cena abre
    // bonita com a colisao desligada, com o visitante atravessando parede.
    // Publicar UM caminho fecha essa porta.
    basePath: `${base}/scenes/${c.id}`,
    description: c.description ?? undefined,
    local: c.local ?? undefined,
    data_captura: c.captured_at ?? undefined,
  };

  if (c.keywords) {
    try { saida.keywords = JSON.parse(c.keywords); } catch { /* keywords invalido: omite */ }
  }
  if (c.lon != null && c.lat != null) saida.locate = { lon: c.lon, lat: c.lat };

  // POSE INICIAL MEDIDA NO OCTREE. Publicar um valor pela metade poria o
  // visitante dentro do chao ou flutuando, entao ou saem os cinco campos ou nao
  // sai nenhum.
  const pose = [c.pose_x, c.pose_y, c.pose_z, c.pose_yaw, c.pose_pitch];
  if (pose.every((v) => v != null)) {
    saida.poseInicial = {
      x: c.pose_x, y: c.pose_y, z: c.pose_z, yaw: c.pose_yaw, pitch: c.pose_pitch,
    };
  }
  if (c.velocidade != null) saida.velocidade = c.velocidade;
  if (c.fov != null) saida.fov = c.fov;

  return saida;
}

export default async function sceneRoutes(fastify) {
  // GET /api/v1/scenes.json: o catalogo das cenas
  //
  // O CAMINHO LEVA `.json` DE PROPOSITO. `/api/v1/scenes` sem extensao colidiria
  // com o prefixo do @fastify/static que serve as pastas, e o vencedor
  // dependeria da ordem de registro dos plugins, que e o pior tipo de contrato.
  fastify.get('/api/v1/scenes.json', async (request, reply) => {
    const base = typeof request.query.base === 'string'
      ? request.query.base.replace(/\/+$/, '')
      : '';
    setCatalogCacheHeaders(reply);
    const cenas = listScenes();
    return {
      count: cenas.length,
      scenes: cenas.map((c) => paraCatalogo(c, base)),
    };
  });

  // GET /api/v1/scene/:id.json: a ficha de uma cena
  fastify.get('/api/v1/scene/:id.json', async (request, reply) => {
    const id = String(request.params.id || '');
    const cena = getScene(id);
    if (!cena) return reply.code(404).send({ error: 'Not Found' });
    setCatalogCacheHeaders(reply);
    const base = typeof request.query.base === 'string'
      ? request.query.base.replace(/\/+$/, '')
      : '';
    return {
      ...paraCatalogo(cena, base),
      importacao: {
        bytes: cena.bytes,
        arquivos: cena.file_count,
        importedAt: cena.imported_at,
      },
    };
  });
}
