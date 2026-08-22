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
import config from './config.js';
import { getIndexDb } from './db/connection.js';
import healthRoutes from './routes/health.js';
import modelRoutes from './routes/models.js';
import tileRoutes from './routes/tiles.js';

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

  getIndexDb();

  await fastify.register(healthRoutes);
  await fastify.register(modelRoutes);
  await fastify.register(tileRoutes);

  return fastify;
}
