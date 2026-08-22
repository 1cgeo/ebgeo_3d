/**
 * @module middleware/cache
 * @description Cache-Control e ETag. Mesmo desenho do ebgeo_360.
 */

import config from '../config.js';

/**
 * FNV-1a de 32 bits, hexadecimal de 8 caracteres. Nao-criptografico e barato:
 * serve de validador onde nao ha adversario para resistir.
 * @param {string} str
 * @returns {string}
 */
export function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Cabecalhos de conteudo imutavel (tile, textura, geometria).
 *
 * `immutable` de um ano so e seguro porque a URI do tile carrega o token de
 * geracao. Ver docs/formato.md.
 * @param {object} reply @param {string} [etag]
 */
export function setTileCacheHeaders(reply, etag) {
  reply.header('Cache-Control', `public, max-age=${config.tileCacheMaxAge}, immutable`);
  if (etag) reply.header('ETag', `"${etag}"`);
}

/**
 * Cabecalhos de documento que pode mudar (tileset.json, catalogo).
 *
 * `no-cache` forca a revalidacao e o ETag a torna barata: o cliente pergunta,
 * o servidor responde 304 sem corpo. O tileset.json TEM de estar aqui, e nao no
 * immutable: uma reimportacao troca a arvore, e com immutable o navegador
 * passaria um ano pedindo um tile que morreu.
 * @param {object} reply @param {string} [etag]
 */
export function setDocumentCacheHeaders(reply, etag) {
  reply.header('Cache-Control', 'public, no-cache');
  if (etag) reply.header('ETag', `"${etag}"`);
}

/** Metadado de catalogo: barato de revalidar, muda pouco. */
export function setCatalogCacheHeaders(reply) {
  reply.header('Cache-Control', 'public, max-age=300');
}

/**
 * ETag de um tile, derivado SEM ler o BLOB.
 *
 * O tile e imutavel dentro de uma geracao, entao (modelo + chave + token)
 * identifica o conteudo. Evita carregar e hashear os bytes, sobretudo no
 * caminho do 304, que existe justamente para nao tocar no BLOB.
 * @param {string} modelId @param {string} chave @param {string} token
 * @returns {string}
 */
export function computeTileETag(modelId, chave, token) {
  return `${modelId}-${fnv1a(chave)}-${token}`;
}
