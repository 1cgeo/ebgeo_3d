/**
 * @module routes/health
 * @description Sonda de saude.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getModelCount, getTotals, listPublishedFiles } from '../db/queries.js';
import { openModelCount } from '../db/connection.js';
import config from '../config.js';

export default async function healthRoutes(fastify) {
  fastify.get('/health', async (_request, reply) => {
    try {
      const models = getModelCount();
      const { bytes, tiles } = getTotals();

      // O CATALOGO E O DISCO PODEM DISCORDAR, e a sonda tem de dizer.
      //
      // O `lote.js` move o `.3dtiles` para o HD externo e o apaga do PC, entao o
      // catalogo fica com registro apontando arquivo que nao esta mais la:
      // medido em 2026-08-22, 67 orfaos de 78 registros. Contando so o
      // catalogo, esta sonda respondia `ok` com quase todo o acervo fora do ar.
      //
      // Um modelo ausente NAO derruba a sonda: o servico esta de pe e serve os
      // outros. Ele muda o status para `degraded`, que e o que separa "nao
      // responde" de "responde menos do que promete".
      //
      // O CUSTO E UM `stat` POR MODELO. Com 111 modelos sao microssegundos, e a
      // alternativa (amostrar) responderia `ok` metade das vezes com o acervo
      // quebrado.
      const ausentes = listPublishedFiles()
        .filter((m) => !existsSync(join(config.modelsDbDir, m.db_filename)))
        .map((m) => m.id);

      const saida = {
        status: ausentes.length ? 'degraded' : 'ok',
        models,
        tiles,
        bytes,
        // Conexoes abertas contra o teto. Se `open` bater no `limit` a toda
        // sonda, o LRU esta girando e a navegacao paga reabertura de banco:
        // e o sinal para subir MAX_OPEN_MODELS ou baixar o cache por banco.
        connections: { open: openModelCount(), limit: config.maxOpenModels },
      };
      if (ausentes.length) {
        saida.missing = {
          count: ausentes.length,
          // A lista sai truncada: com o acervo inteiro fora do ar ela teria 111
          // entradas, e a sonda viraria despejo de log.
          ids: ausentes.slice(0, 10),
        };
      }
      return saida;
    } catch (err) {
      reply.code(503);
      return { status: 'error', message: err.message };
    }
  });
}
