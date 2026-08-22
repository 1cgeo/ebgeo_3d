#!/usr/bin/env node

/**
 * @module scripts/adotar
 * @description Registra no catalogo um `.3dtiles` que ja esta em disco.
 *
 * POR QUE ISTO EXISTE, e o caso e real. Em 2026-08-22 o `importar.js` deixou de
 * passar uma coluna nova ao `upsertModel`, e o better-sqlite3 exige todo
 * parametro nomeado: ele lancava no PASSO 7. Os passos 1 a 6 tinham passado, o
 * arquivo estava no disco com o tamanho certo, a saida dizia "publicado", e o
 * modelo nao existia para o servico. Quatro modelos ficaram assim, somando 40
 * minutos de conversao.
 *
 * Reconverter para consertar um INSERT seria jogar esse tempo fora. O cabecalho
 * `meta` de cada `.3dtiles` guarda tudo que o passo 7 precisa, e foi escrito
 * para isso (o `--promover` ja o usa). Este roteiro le dali.
 *
 * O QUE ELE NAO FAZ: nao converte, nao troca arquivo, nao mede nada que o
 * arquivo nao contenha. Modelo cujo cabecalho esteja incompleto e RECUSADO, e
 * nao completado por adivinhacao.
 *
 * Uso:
 *   node scripts/adotar.js --dry-run     # lista o que esta em disco e fora do catalogo
 *   node scripts/adotar.js               # registra todos
 *   node scripts/adotar.js --id aerodromo
 */

import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import config from '../src/config.js';
import { getIndexDb, closeAll } from '../src/db/connection.js';
import { upsertModel, getModelAny } from '../src/db/queries.js';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const somenteId = (() => { const i = argv.indexOf('--id'); return i >= 0 ? argv[i + 1] : null; })();

/** Campos do cabecalho sem os quais o registro seria adivinhacao. */
const OBRIGATORIOS = ['id', 'buildToken', 'builtAt', 'tileCount'];

/** Le a tabela `meta` de um .3dtiles. */
function leCabecalho(caminho) {
  const db = new Database(caminho, { readonly: true });
  try {
    const m = {};
    for (const r of db.prepare('SELECT key, value FROM meta').iterate()) m[r.key] = r.value;
    const tiles = db.prepare("SELECT COUNT(*) AS n FROM media WHERE key LIKE '%.glb'").get().n;
    return { meta: m, tilesNoArquivo: tiles };
  } finally {
    db.close();
  }
}

getIndexDb();

if (!existsSync(config.modelsDbDir)) {
  console.error(`ERRO: ${config.modelsDbDir} nao existe.`);
  process.exit(2);
}

const arquivos = readdirSync(config.modelsDbDir)
  .filter((f) => f.endsWith('.3dtiles'))
  .filter((f) => !f.startsWith('_'))
  .filter((f) => !somenteId || f === `${somenteId}.3dtiles`);

console.log(`${arquivos.length} arquivos em ${config.modelsDbDir}\n`);

let adotados = 0;
let jaEstavam = 0;
const recusados = [];

for (const arquivo of arquivos) {
  const caminho = join(config.modelsDbDir, arquivo);
  const idPeloNome = arquivo.replace(/\.3dtiles$/, '');

  // QUEM JA ESTA NO CATALOGO SAI ANTES DA VALIDACAO. O cabecalho pode ser de uma
  // versao anterior do importador e nao ter tudo que este roteiro exige, e
  // recusar um modelo que esta servido e alarme falso: ele nao precisa ser
  // adotado.
  if (getModelAny(idPeloNome)) { jaEstavam++; continue; }

  let cab;
  try {
    cab = leCabecalho(caminho);
  } catch (err) {
    recusados.push(`${idPeloNome}: cabecalho ilegivel (${err.message})`);
    continue;
  }
  const { meta, tilesNoArquivo } = cab;

  const faltando = OBRIGATORIOS.filter((k) => !meta[k]);
  if (faltando.length) {
    recusados.push(`${idPeloNome}: cabecalho sem ${faltando.join(', ')}`);
    continue;
  }

  // O ID DO CABECALHO MANDA, e o do nome do arquivo confere. Divergencia aqui
  // significa arquivo renomeado a mao, e adotar pelo nome poria o conteudo de um
  // modelo sob o id de outro.
  if (meta.id !== idPeloNome) {
    recusados.push(`${idPeloNome}: o cabecalho diz id "${meta.id}"`);
    continue;
  }

  // A CONTAGEM DO CABECALHO CONTRA A DO ARQUIVO. Divergencia denuncia
  // importacao interrompida no meio da conversao, e um modelo pela metade nao
  // se publica.
  if (Number(meta.tileCount) !== tilesNoArquivo) {
    recusados.push(`${idPeloNome}: o cabecalho diz ${meta.tileCount} tiles e o arquivo tem ${tilesNoArquivo}`);
    continue;
  }

  const bytes = statSync(caminho).size;
  const altura = meta.height != null ? Number(meta.height) : null;
  console.log(`${meta.id}`);
  console.log(`  ${tilesNoArquivo.toLocaleString('pt-BR')} tiles, ${(bytes / 2 ** 20).toFixed(1)} MiB,`
    + ` token ${meta.buildToken}, convertido em ${meta.builtAt}`);
  if (meta.lon) console.log(`  navegacao lon=${meta.lon} lat=${meta.lat} chao=${meta.groundHeight ?? '-'}`);

  if (!dryRun) {
    upsertModel({
      id: meta.id,
      name: meta.name || meta.id,
      db_filename: arquivo,
      source: null,
      source_version: null,
      captured_at: null,
      tiles_version: meta.tilesVersion || '1.1',
      geometry_codec: meta.geometry || 'draco',
      texture_codec: meta.texture || 'ktx2-etc1s',
      texture_quality: Number(meta.textureQuality || 200),
      tile_count: tilesNoArquivo,
      json_count: Number(meta.jsonCount || 0),
      total_bytes: bytes,
      source_bytes: Number(meta.sourceBytes || 0),
      build_token: meta.buildToken,
      built_at: meta.builtAt,
      lon: meta.lon != null ? Number(meta.lon) : null,
      lat: meta.lat != null ? Number(meta.lat) : null,
      // O cabecalho guarda a altura do CHAO; o catalogo publica a de CAMERA, que
      // e ela mais 500 m. A mesma conta do passo 7 do importar.js.
      height: altura != null ? altura + 500 : null,
      ground_height: meta.groundHeight != null ? Number(meta.groundHeight) : null,
      min_height: meta.minHeight != null ? Number(meta.minHeight) : null,
      height_offset: null,
      max_sse: null,
      model_type: meta.modelType || '3dtiles',
      position_lon: meta.positionLon != null ? Number(meta.positionLon) : null,
      position_lat: meta.positionLat != null ? Number(meta.positionLat) : null,
      rot_heading: null,
      rot_pitch: null,
      rot_roll: null,
      scale: null,
      description: null,
      local: null,
      keywords: null,
      preview_video: null,
      preview_thumb: null,
      published: meta.published === '0' ? 0 : 1,
    });
    adotados++;
  }
}

console.log();
if (jaEstavam) console.log(`${jaEstavam} ja estavam no catalogo`);
if (recusados.length) {
  console.log(`RECUSADOS (${recusados.length}):`);
  for (const r of recusados) console.log(`  ${r}`);
}
console.log(dryRun ? 'dry-run: nada gravado' : `${adotados} modelos adotados`);
closeAll();
