/**
 * @module build-app
 * @description Monta a instancia Fastify sem escutar porta.
 *
 * EXISTE PARA O TESTE PODER USAR `app.inject()`. O server.js chama esta funcao e
 * so acrescenta o listen e o encerramento gracioso, entao o que o teste exercita
 * e o mesmo grafo de rotas que sobe em producao. O ebgeo_360 aprendeu isso do
 * jeito caro: uma rota registrada so no server.js passou nos testes e respondeu
 * 404 no servico vivo.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyCompress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import { existsSync, mkdirSync } from 'node:fs';
import config from './config.js';
import { getIndexDb } from './db/connection.js';
import healthRoutes from './routes/health.js';
import modelRoutes from './routes/models.js';
import tileRoutes from './routes/tiles.js';
import sceneRoutes from './routes/scenes.js';

/** Corpo de requisicao: este servico so le, entao 8 KB e folgado. */
const BODY_LIMIT_BYTES = 8 * 1024;

/**
 * @param {object} [opcoes]
 * @param {boolean} [opcoes.logger] - false nos testes
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
export async function buildApp({ logger = true } = {}) {
  const fastify = Fastify({
    logger: logger ? { level: config.logLevel } : false,
    bodyLimit: BODY_LIMIT_BYTES,
  });

  fastify.setErrorHandler((err, request, reply) => {
    const statusCode = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (statusCode >= 500) {
      request.log.error(err);
      return reply.code(statusCode).send({ error: 'Internal Server Error' });
    }
    request.log.warn(err);
    return reply.code(statusCode).send({ error: err.message });
  });

  fastify.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: 'Not Found' });
  });

  // COMPRESSAO SO PARA O QUE COMPRIME. O tileset.json entra (JSON puro comprime
  // bem, e um tileset de raiz grande passa de 1 MB). O .glb fica FORA de
  // proposito: dentro dele a geometria ja esta em Draco e a textura em ETC1S,
  // dois formatos que nao cedem quase nada ao gzip e cobrariam CPU do servidor
  // a cada tile. `model/gltf-binary` nao casa com o regex abaixo.
  await fastify.register(fastifyCompress, {
    global: true,
    customTypes: /^(?:text\/|application\/(?:json|javascript|.*\+json))/,
  });

  await fastify.register(cors, { origin: config.corsOrigin });

  // MINIATURA E VIDEO DE PREVIA, servidos como arquivo. Espelha o
  // `/api/v1/thumbnails/` do ebgeo_360, e pela mesma razao: o catalogo do
  // cliente precisa de uma imagem por modelo, e ela nao cabe num JSON.
  //
  // O DIRETORIO NASCE AQUI se nao existir. Sem isso o @fastify/static recusa a
  // subir o servico inteiro por causa de um diretorio de previa vazio, e o
  // acervo de tiles, que e o que importa, para junto.
  if (!existsSync(config.assetsDir)) mkdirSync(config.assetsDir, { recursive: true });
  await fastify.register(fastifyStatic, {
    root: config.assetsDir,
    prefix: '/api/v1/assets/',
    // A previa nao carrega token de geracao na URL, entao ela NAO pode levar
    // `immutable`: trocar a miniatura de um modelo tem de aparecer no cliente.
    // Uma hora e o meio-termo entre isso e um pedido por card do catalogo.
    cacheControl: true,
    maxAge: 3600,
    index: false,
    list: false,
  });

  // CENAS: uma pasta por cena, servida como arquivo.
  //
  // `decorateReply: false` porque o @fastify/static so pode decorar a resposta
  // com `sendFile` UMA vez, e o registro das previas acima ja o fez. Sem isso o
  // segundo registro derruba o servico na partida.
  if (!existsSync(config.scenesDir)) mkdirSync(config.scenesDir, { recursive: true });
  await fastify.register(fastifyStatic, {
    root: config.scenesDir,
    prefix: '/api/v1/scenes/',
    decorateReply: false,
    // O splat e o octree sao imutaveis dentro de uma cena, mas a URL deles NAO
    // carrega token de geracao: reimportar a cena troca os bytes sem trocar o
    // endereco. Uma hora, como as previas, e nao um ano.
    cacheControl: true,
    maxAge: 3600,
    index: false,
    list: false,
    // `acceptRanges` fica LIGADO (e o padrao): o visualizador le o `voxel.bin`
    // em faixa, e sem isso ele baixaria o octree inteiro para ler o cabecalho.
  });

  getIndexDb();

  await fastify.register(healthRoutes);
  await fastify.register(modelRoutes);
  await fastify.register(sceneRoutes);
  await fastify.register(tileRoutes);

  return fastify;
}
