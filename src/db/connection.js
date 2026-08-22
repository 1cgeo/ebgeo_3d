/**
 * @module db/connection
 * @description Conexoes SQLite: o index.db central e os bancos por modelo.
 *
 * DIFERENCA DELIBERADA PARA O ebgeo_360. La as conexoes de projeto vivem num Map
 * sem despejo, e esta certo: sao 27 projetos com 32 MB de cache cada. Aqui sao
 * 115 modelos, e o mesmo desenho reservaria 3,7 GB de cache dentro de um
 * container limitado a 512 MB. Por isso a conexao de modelo entra num LRU com
 * teto (config.maxOpenModels), e o cache por banco e menor.
 */

import Database from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config.js';
import { resetStatements } from './queries.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

let indexDb = null;

/**
 * LRU de conexoes de modelo. Map preserva ordem de insercao, entao o primeiro
 * item e o menos usado recentemente depois de cada `toque`.
 * @type {Map<string, import('better-sqlite3').Database>}
 */
const modelDbs = new Map();

/**
 * Abre e inicializa o banco central de metadado.
 * @returns {import('better-sqlite3').Database}
 */
export function getIndexDb() {
  if (indexDb) return indexDb;

  if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true });
  if (!existsSync(config.modelsDbDir)) mkdirSync(config.modelsDbDir, { recursive: true });

  indexDb = new Database(config.indexDbPath);
  indexDb.pragma('journal_mode = WAL');
  indexDb.pragma('synchronous = NORMAL');
  indexDb.pragma('cache_size = -16000');   // 16 MB: aqui so ha metadado
  indexDb.pragma('busy_timeout = 5000');
  indexDb.pragma('foreign_keys = ON');

  const schema = readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8');
  indexDb.exec(schema);

  return indexDb;
}

/**
 * Aplica os pragmas de leitura de um banco de modelo.
 *
 * Os mesmos do ebgeo_360, com os numeros recalibrados pelo tamanho do BLOB
 * (tile de dezenas de KB contra foto de megabytes). Ver config.js.
 * @param {import('better-sqlite3').Database} db
 */
function pragmasDeLeitura(db) {
  db.pragma('query_only = true');
  db.pragma(`cache_size = ${config.modelCacheSizeKb}`);
  db.pragma('busy_timeout = 5000');
  db.pragma(`mmap_size = ${config.modelMmapBytes}`);
}

/**
 * Marca a conexao como usada agora, reinserindo-a no fim do Map.
 * @param {string} chave
 * @param {import('better-sqlite3').Database} db
 */
function toque(chave, db) {
  modelDbs.delete(chave);
  modelDbs.set(chave, db);
}

/**
 * Fecha a conexao menos usada, se o teto foi ultrapassado.
 *
 * FECHAR IMPORTA MAIS NO WINDOWS do que a memoria sugere: um handle aberto ainda
 * segura o arquivo, e uma conexao orfa impede ate substituir o .3dtiles numa
 * reimportacao.
 */
function despeja() {
  while (modelDbs.size > config.maxOpenModels) {
    const [chave, db] = modelDbs.entries().next().value;
    modelDbs.delete(chave);
    try { db.close(); } catch { /* conexao ja fechada: nada a fazer */ }
  }
}

/**
 * Abre (ou reaproveita) o banco de um modelo, somente leitura.
 * @param {string} dbFilename - Nome do arquivo em data/models/
 * @returns {import('better-sqlite3').Database|null} null se o arquivo nao existe
 */
export function getModelDb(dbFilename) {
  const cache = modelDbs.get(dbFilename);
  if (cache && cache.open) {
    toque(dbFilename, cache);
    return cache;
  }

  const dbPath = join(config.modelsDbDir, dbFilename);
  if (!existsSync(dbPath)) return null;

  const db = new Database(dbPath, { readonly: true });
  pragmasDeLeitura(db);
  modelDbs.set(dbFilename, db);
  despeja();
  return db;
}

/**
 * Fecha a conexao de um modelo, se estiver aberta.
 *
 * Usado pela reimportacao: no Windows, escrever por cima de um arquivo com
 * handle aberto falha, e o sintoma (EPERM) nao diz que a causa e esta.
 * @param {string} dbFilename
 */
export function closeModelDb(dbFilename) {
  const db = modelDbs.get(dbFilename);
  if (!db) return;
  modelDbs.delete(dbFilename);
  try { db.close(); } catch { /* ja fechada */ }
}

/**
 * Cria um banco de modelo para ESCRITA, com os pragmas de carga em lote.
 *
 * O QUE REALMENTE CUSTA NA CARGA, medido com 8.000 blobs de 40 KiB:
 *
 *   tamanho da transacao   lote de 1 contra lote de 256:  24x
 *   synchronous            FULL contra OFF:                2x
 *   journal_mode           MEMORY contra DELETE:      nenhum
 *   cache_size             2 MB contra 64 MB:         nenhum
 *
 * A transacao em lote e o que decide, e ela vive no importar.js (LOTE_ESCRITA).
 * Aqui sobra o `synchronous = OFF`, que vale 2x e e seguro durante a construcao:
 * o arquivo nasce do zero e o conserto de uma queda e apagar e recomecar.
 *
 * `journal_mode = MEMORY` E NAO `OFF`. O SQLite RECUSA o OFF nesta situacao e
 * devolve `delete` sem reclamar, entao pedir OFF dava a impressao de uma
 * otimizacao que nunca aconteceu. O MEMORY e aceito, e o teste confere o valor
 * EFETIVO em vez do que pedimos.
 *
 * O journal volta a DELETE no fim da importacao (ver finalizarModelDb).
 *
 * @param {string} caminho - Caminho absoluto do arquivo a criar
 * @returns {import('better-sqlite3').Database}
 */
export function createModelDb(caminho) {
  const db = new Database(caminho);
  // page_size TEM de vir antes de qualquer tabela: depois disso ele so muda por
  // VACUUM, que reescreve o arquivo inteiro.
  db.pragma('page_size = 4096');
  db.pragma('journal_mode = MEMORY');
  db.pragma('synchronous = OFF');
  db.pragma('cache_size = -64000');
  const schema = readFileSync(resolve(__dirname, 'model-schema.sql'), 'utf-8');
  db.exec(schema);
  return db;
}

/**
 * Fecha um banco recem-construido deixando-o pronto para producao.
 *
 * `journal_mode = DELETE`, e nao WAL. Em WAL o SQLite precisa criar o `-shm` ao
 * abrir, e num volume montado `:ro` isso derruba o servico com um erro que nao
 * aponta a causa. A DGEO ja pagou esse defeito na publicacao do terreno. Fora do
 * WAL o modelo vira arquivo unico, que e o que se copia para producao.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function finalizarModelDb(db) {
  db.pragma('journal_mode = DELETE');
  db.pragma('synchronous = FULL');
  db.close();
}

/**
 * Fecha todas as conexoes. Chamar no encerramento gracioso.
 */
export function closeAll() {
  resetStatements();
  if (indexDb) {
    indexDb.close();
    indexDb = null;
  }
  for (const [nome, db] of modelDbs) {
    try { db.close(); } catch { /* ja fechada */ }
    modelDbs.delete(nome);
  }
}

/**
 * Quantas conexoes de modelo estao abertas. Usado pelo /health.
 * @returns {number}
 */
export function openModelCount() {
  return modelDbs.size;
}
