/**
 * @module db/tiles-queries
 * @description Prepared statements do banco de um modelo ({slug}.3dtiles).
 *
 * A CADA ACESSO conferimos mtime e tamanho do arquivo, pela mesma razao do
 * ebgeo_360: se uma reimportacao TROCA o arquivo com o servico no ar, a conexao
 * viva continua presa ao arquivo antigo e passa a servir tile velho sob um
 * `immutable` de um ano. A conferencia custa um statSync, que o cache de
 * metadado do sistema operacional serve sem tocar no disco.
 *
 * O tamanho entra junto do mtime porque a granularidade do mtime chega a um
 * segundo em alguns sistemas de arquivos, e uma troca dentro do mesmo segundo
 * passaria batida.
 */

import Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import config from '../config.js';
import { getModelDb, closeModelDb } from './connection.js';

/**
 * Cache por arquivo: { db, propria, mtimeMs, size, get, meta }.
 * @type {Map<string, object>}
 */
const _stmts = new Map();

/** Arquivos cuja conexao rotacionou e por isso passou a ser deste modulo. */
const _rotacionados = new Set();

function abrirConexao(dbFilename, caminho) {
  if (!_rotacionados.has(dbFilename)) {
    const db = getModelDb(dbFilename);
    return db ? { db, propria: false } : null;
  }
  // Depois de uma rotacao a conexao e NOSSA: o LRU de connection.js e privado e
  // nao tem como devolver uma conexao nova para o mesmo nome.
  const db = new Database(caminho, { readonly: true });
  db.pragma('query_only = true');
  db.pragma(`cache_size = ${config.modelCacheSizeKb}`);
  db.pragma('busy_timeout = 5000');
  db.pragma(`mmap_size = ${config.modelMmapBytes}`);
  return { db, propria: true };
}

function descartar(dbFilename) {
  const c = _stmts.get(dbFilename);
  if (!c) return;
  _stmts.delete(dbFilename);
  if (c.propria) {
    try { c.db.close(); } catch { /* ja fechada */ }
  }
}

/**
 * Devolve os statements do modelo, ou null se o arquivo nao existe.
 * @param {string} dbFilename
 * @returns {{get:object, meta:object, db:object}|null}
 */
function modelStmts(dbFilename) {
  const caminho = join(config.modelsDbDir, dbFilename);
  const info = statSync(caminho, { throwIfNoEntry: false });
  if (!info) {
    descartar(dbFilename);
    return null;
  }

  const cache = _stmts.get(dbFilename);
  if (cache && cache.db.open && cache.mtimeMs === info.mtimeMs && cache.size === info.size) {
    return cache;
  }

  // Arquivo trocado: solta o antigo dos dois lados antes de reabrir.
  descartar(dbFilename);
  closeModelDb(dbFilename);
  _rotacionados.add(dbFilename);

  const aberta = abrirConexao(dbFilename, caminho);
  if (!aberta) return null;

  const entrada = {
    db: aberta.db,
    propria: aberta.propria,
    mtimeMs: info.mtimeMs,
    size: info.size,
    get: aberta.db.prepare('SELECT content FROM media WHERE key = ?'),
    meta: aberta.db.prepare('SELECT value FROM meta WHERE key = ?'),
    contar: aberta.db.prepare('SELECT COUNT(*) AS n FROM media'),
  };
  _stmts.set(dbFilename, entrada);
  return entrada;
}

/**
 * Le uma chave do modelo.
 * @param {string} dbFilename
 * @param {string} chave - Caminho relativo, com barra normal e sem barra inicial
 * @returns {Buffer|null}
 */
export function getMedia(dbFilename, chave) {
  const s = modelStmts(dbFilename);
  if (!s) return null;
  const linha = s.get.get(chave);
  return linha ? linha.content : null;
}

/**
 * Le um campo do cabecalho do modelo.
 * @param {string} dbFilename @param {string} chave @returns {string|null}
 */
export function getMeta(dbFilename, chave) {
  const s = modelStmts(dbFilename);
  if (!s) return null;
  const linha = s.meta.get(chave);
  return linha ? linha.value : null;
}

/**
 * Conta as entradas do modelo. Usado pela conferencia, nao pelo caminho quente.
 * @param {string} dbFilename @returns {number|null}
 */
export function countMedia(dbFilename) {
  const s = modelStmts(dbFilename);
  return s ? s.contar.get().n : null;
}

/** Fecha o que este modulo abriu. Chamado no encerramento. */
export function resetTileStatements() {
  for (const nome of [..._stmts.keys()]) descartar(nome);
  _rotacionados.clear();
}
