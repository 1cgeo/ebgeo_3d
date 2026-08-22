/**
 * @module server
 * @description Ponto de entrada do servico 3D. Serve tilesets 3D Tiles 1.1 a
 * partir de bancos SQLite, um por modelo.
 */

import { buildApp } from './build-app.js';
import config from './config.js';
import { closeAll } from './db/connection.js';
import { resetTileStatements } from './db/tiles-queries.js';

const fastify = await buildApp();

/** Tempo maximo, em ms, para o close() antes de forcar a saida. */
const SHUTDOWN_TIMEOUT_MS = 10000;
let encerrando = false;

/**
 * Fecha os bancos das duas donarias.
 *
 * closeAll() fecha o que connection.js abriu; as conexoes que rotacionaram por
 * troca de arquivo pertencem a tiles-queries.js e so ele as fecha. No Windows um
 * handle aberto ainda segura o arquivo, entao deixar uma de fora atrapalha ate
 * quem for reimportar o modelo depois.
 */
function fecharBancos() {
  resetTileStatements();
  closeAll();
}

async function encerrar(codigo = 0) {
  if (encerrando) return;
  encerrando = true;
  fastify.log.info('Encerrando...');

  const forcar = setTimeout(() => {
    fastify.log.error('Tempo de encerramento estourado, saindo a forca');
    fecharBancos();
    process.exit(codigo || 1);
  }, SHUTDOWN_TIMEOUT_MS);
  forcar.unref();

  try {
    await fastify.close();
  } catch (err) {
    fastify.log.error(err, 'Erro ao fechar o servidor');
  } finally {
    clearTimeout(forcar);
    fecharBancos();
    process.exit(codigo);
  }
}

process.on('SIGINT', () => encerrar(0));
process.on('SIGTERM', () => encerrar(0));
process.on('uncaughtException', (err) => {
  fastify.log.error(err, 'Excecao nao tratada');
  encerrar(1);
});
process.on('unhandledRejection', (motivo) => {
  const err = motivo instanceof Error ? motivo : new Error(String(motivo));
  fastify.log.error(err, 'Rejeicao nao tratada');
  encerrar(1);
});

try {
  await fastify.listen({ port: config.port, host: config.host });
  fastify.log.info(`Servico 3D em ${config.host}:${config.port}, dados em ${config.dataDir}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
