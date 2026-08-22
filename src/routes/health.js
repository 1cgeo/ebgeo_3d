/**
 * @module routes/health
 * @description Sonda de saude.
 */

import { getModelCount, getTotals } from '../db/queries.js';
import { openModelCount } from '../db/connection.js';
import config from '../config.js';

export default async function healthRoutes(fastify) {
  fastify.get('/health', async (_request, reply) => {
    try {
      const models = getModelCount();
      const { bytes, tiles } = getTotals();
      return {
        status: 'ok',
        models,
        tiles,
        bytes,
        // Conexoes abertas contra o teto. Se `open` bater no `limit` a toda
        // sonda, o LRU esta girando e a navegacao paga reabertura de banco:
        // e o sinal para subir MAX_OPEN_MODELS ou baixar o cache por banco.
        connections: { open: openModelCount(), limit: config.maxOpenModels },
      };
    } catch (err) {
      reply.code(503);
      return { status: 'error', message: err.message };
    }
  });
}
