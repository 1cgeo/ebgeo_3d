/**
 * @module routes/tiles
 * @description Serve o conteudo de um modelo: o tileset.json e cada tile.
 *
 * POR QUE UMA ROTA CURINGA. O CesiumJS pede o `tileset.json` e resolve tudo que
 * vem dentro dele RELATIVO a essa URL: um `content.uri` de "Data/d000/c00.glb"
 * vira ".../models/{id}/Data/d000/c00.glb". A arvore tem profundidade variavel e
 * nomes que o gerador escolheu, entao nao ha rota fixa que a cubra. O curinga
 * entrega exatamente a chave que o banco guarda, e o cliente nem sabe que do
 * outro lado ha um SQLite em vez de um diretorio.
 *
 * O `?v=` DAS URIs CHEGA AQUI E E IGNORADO de proposito. Ele nao e parametro: e
 * o token de geracao que separa a URL do tile velho da do novo sob `immutable`.
 * Quem o consome e o cache, nunca este handler. Por isso a rota segue sem schema
 * de query: um `additionalProperties: false` responderia 400 no tile inteiro por
 * causa do proprio token que o tileset.json publicou.
 *
 * E NAO SE COMPARA o token com o build_token de agora. No instante seguinte a
 * uma reimportacao o cliente ainda segura o tileset.json velho, e recusar o
 * token antigo pintaria a cena de buraco em vez de servir o tile bom. A resposta
 * certa e sempre o conteudo de hoje, com o ETag de hoje.
 */

import { getModel } from '../db/queries.js';
import { getMedia } from '../db/tiles-queries.js';
import {
  setTileCacheHeaders,
  setDocumentCacheHeaders,
  computeTileETag,
} from '../middleware/cache.js';
import config from '../config.js';

/**
 * Content-Type por extensao.
 *
 * `model/gltf-binary` para .glb e o tipo registrado na IANA. O b3dm nao tem tipo
 * registrado, entao vai como octet-stream; ele so aparece em modelo importado
 * sem conversao, que e caminho de excecao.
 */
const TIPOS = {
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.b3dm': 'application/octet-stream',
  '.pnts': 'application/octet-stream',
  '.i3dm': 'application/octet-stream',
  '.cmpt': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
  '.bin': 'application/octet-stream',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.subtree': 'application/octet-stream',
};

function tipoDe(chave) {
  const ponto = chave.lastIndexOf('.');
  if (ponto < 0) return 'application/octet-stream';
  return TIPOS[chave.slice(ponto).toLowerCase()] || 'application/octet-stream';
}

/**
 * Normaliza a chave pedida na URL para a forma guardada no banco.
 *
 * Recusa qualquer coisa que tente subir de diretorio. Aqui isso NAO e defesa
 * contra travessia de sistema de arquivos, porque nao ha sistema de arquivos do
 * outro lado: e higiene de chave, para "a/../b.glb" e "b.glb" nao virarem duas
 * entradas de cache do mesmo objeto.
 *
 * @param {string} bruto - Parte curinga da URL
 * @returns {string|null} Chave normalizada, ou null se invalida
 */
export function normalizaChave(bruto) {
  if (!bruto) return null;
  // SEM decodeURIComponent AQUI. O Fastify ja decodifica o curinga antes de
  // entregar em `params['*']`, e decodificar de novo quebra a chave que contem um
  // por-cento literal: "Data/100%.glb" chega ja decodificada, o segundo decode
  // acha um escape malformado e a rota responde 400 num arquivo que existe.
  // Medido com app.inject: "100%25.glb" chega como "Data/100%.glb".
  let chave = String(bruto).split('?')[0].replace(/\\/g, '/');
  if (chave.startsWith('/')) chave = chave.slice(1);
  if (chave === '' || chave.includes('\0')) return null;
  if (chave.split('/').some((p) => p === '..' || p === '.')) return null;
  return chave;
}

let _emVoo = 0;
const _fila = [];

/** Adquire uma vaga do limitador de concorrencia. @returns {Promise<void>} */
function pegaVaga() {
  if (_emVoo < config.maxInflightTiles) {
    _emVoo++;
    return Promise.resolve();
  }
  return new Promise((resolve) => _fila.push(resolve));
}

/** Devolve a vaga, promovendo o proximo da fila se houver. */
function soltaVaga() {
  const proximo = _fila.shift();
  if (proximo) proximo();            // a vaga passa direto, _emVoo fica constante
  else _emVoo--;
}

export default async function tileRoutes(fastify) {
  fastify.get('/api/v1/models/:id/*', async (request, reply) => {
    const { id } = request.params;
    const chave = normalizaChave(request.params['*']);
    if (!chave) {
      reply.code(400);
      return { error: 'Invalid key' };
    }

    const modelo = getModel(id);
    if (!modelo) {
      reply.code(404);
      return { error: 'Model not found' };
    }

    const etag = computeTileETag(id, chave, modelo.build_token);
    const documento = chave.toLowerCase().endsWith('.json');

    // O 304 curto-circuita ANTES de ler o BLOB, que e o unico custo que importa
    // nesta rota. A linha de models ja estava em maos.
    const seNenhum = request.headers['if-none-match'];
    if (seNenhum && seNenhum.replace(/"/g, '') === etag) {
      if (documento) setDocumentCacheHeaders(reply, etag);
      else setTileCacheHeaders(reply, etag);
      reply.code(304);
      return;
    }

    await pegaVaga();
    let liberada = false;
    const libera = () => {
      if (liberada) return;
      liberada = true;
      soltaVaga();
    };

    let conteudo;
    try {
      conteudo = getMedia(modelo.db_filename, chave);
    } catch (err) {
      libera();
      throw err;
    }
    if (!conteudo) {
      libera();
      reply.code(404);
      return { error: 'Tile not found' };
    }

    if (documento) setDocumentCacheHeaders(reply, etag);
    else setTileCacheHeaders(reply, etag);
    reply.header('Content-Type', tipoDe(chave));
    reply.header('Content-Length', conteudo.length);

    // A vaga so volta quando a resposta FECHA: o buffer vive ate o ultimo byte
    // sair, e soltar antes faria o teto medir o que nao e. 'close' cobre os dois
    // casos, o envio completo e o cliente que desistiu.
    reply.raw.on('close', libera);
    reply.raw.on('error', libera);
    // Cliente que desistiu ANTES desta linha ja emitiu o 'close', e um listener
    // atrasado nunca dispara: sem esta guarda a vaga sumiria para sempre.
    if (reply.raw.destroyed) libera();
    return reply.send(conteudo);
  });
}
