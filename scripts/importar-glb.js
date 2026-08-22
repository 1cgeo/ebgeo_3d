#!/usr/bin/env node

/**
 * @module scripts/importar-glb
 * @description Importa um MODELO GLB SOLTO: um arquivo unico, sem arvore e sem
 * tileset.json.
 *
 * POR QUE UM ROTEIRO SEPARADO. O `importar.js` cuida de ARVORE: ele inventaria
 * milhares de tiles, reescreve tileset.json, escala geometricError, mede
 * envelope e confere referencia. Nada disso existe aqui, e enfiar os dois
 * caminhos num roteiro so faria cada `if` do fluxo carregar uma pergunta que
 * nao e do problema. O que os dois compartilham de verdade (a conversao, a
 * troca do arquivo publicado, o catalogo) esta em modulo comum.
 *
 * O QUE O ARQUIVO NAO SABE, E VOCE TEM DE DIZER. Um `.glb` comum traz
 * coordenada LOCAL, e nao georreferencia: sem `--lon` e `--lat` o Cesium o
 * planta no centro da Terra. Nao ha como medir isso do arquivo, entao o
 * roteiro RECUSA em vez de chutar um lugar.
 *
 * O CesiumJS carrega este tipo por `Model.fromGltfAsync`, e nao por
 * `Cesium3DTileset.fromUrl`. Quem decide e o campo `type: 'glb'` do catalogo.
 *
 * Uso:
 *   node scripts/importar-glb.js --origem <arquivo.glb ou pasta> --id <slug> \
 *     --lon -44.447668 --lat -22.454757 [--altura 50] [--heading 180] \
 *     [--pitch 0] [--roll 0] [--escala 1] [--nome "..."] [--dry-run]
 */

import { readFileSync, statSync, existsSync, readdirSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import config from '../src/config.js';
import { createModelDb, finalizarModelDb, getIndexDb, closeAll, closeModelDb } from '../src/db/connection.js';
import { upsertModel, openImport, closeImport, getModelAny } from '../src/db/queries.js';
import { versaoKtx, QLEVEL_PADRAO } from './lib/ktx2.js';
import { criarConversor } from './lib/conversor.js';
import { abrirTile, leGerador, extensoesNaoSuportadas } from './lib/b3dm.js';
import { MAX_TEXTURA_PADRAO } from './lib/tileset.js';
import { trocaArquivo } from './lib/deposito.js';

/** Nome com que o GLB e servido, sempre o mesmo. */
const CHAVE = 'model.glb';

function args() {
  const a = process.argv.slice(2);
  const v = (n, p) => { const i = a.indexOf(n); return i >= 0 && a[i + 1] ? a[i + 1] : p; };
  const num = (n, p) => { const x = v(n); return x == null ? p : Number(x); };
  return {
    origem: v('--origem'),
    id: v('--id'),
    nome: v('--nome'),
    lon: num('--lon', null),
    lat: num('--lat', null),
    altura: num('--altura', 0),
    heading: num('--heading', 0),
    pitch: num('--pitch', 0),
    roll: num('--roll', 0),
    escala: num('--escala', 1),
    qlevel: parseInt(v('--qlevel', String(QLEVEL_PADRAO)), 10),
    geometria: v('--geometria', 'draco'),
    maxTextura: parseInt(v('--max-textura', String(MAX_TEXTURA_PADRAO)), 10),
    forcar: a.includes('--forcar'),
    dryRun: a.includes('--dry-run'),
  };
}

/** Resolve o arquivo: aceita o .glb direto, ou a pasta que contem um so. */
function achaGlb(origem) {
  if (!existsSync(origem)) return { erro: `origem nao existe: ${origem}` };
  if (statSync(origem).isFile()) {
    return extname(origem).toLowerCase() === '.glb'
      ? { arquivo: origem }
      : { erro: `${basename(origem)} nao e .glb` };
  }
  const glbs = readdirSync(origem)
    .filter((f) => extname(f).toLowerCase() === '.glb')
    .map((f) => join(origem, f));
  if (glbs.length === 0) return { erro: `nenhum .glb em ${origem}` };
  // MAIS DE UM E AMBIGUO, e ambiguo nao se adivinha: escolher o maior, ou o
  // primeiro em ordem, seria decidir no lugar do operador sem ele saber.
  if (glbs.length > 1) {
    return { erro: `${glbs.length} arquivos .glb em ${origem}. Aponte um: ${glbs.map(basename).join(', ')}` };
  }
  return { arquivo: glbs[0] };
}

async function main() {
  const o = args();
  if (!o.origem || !o.id) {
    console.error('Uso: node scripts/importar-glb.js --origem <arquivo.glb|pasta> --id <slug>'
      + ' --lon <graus> --lat <graus> [--altura N] [--heading N] [--escala N]');
    process.exit(2);
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(o.id)) {
    console.error(`ERRO: --id "${o.id}" invalido. Use minusculas, digitos, hifen e sublinhado.`);
    process.exit(2);
  }

  // O PORTAO DO LUGAR VEM ANTES DA CONVERSAO. Converter para so entao descobrir
  // que ninguem sabe onde o modelo fica desperdicaria a corrida inteira, e
  // gravar um modelo sem posicao o poria no centro da Terra sem um erro.
  if (o.lon == null || o.lat == null || Number.isNaN(o.lon) || Number.isNaN(o.lat)) {
    console.error('ERRO: --lon e --lat sao obrigatorios.');
    console.error('Um .glb traz coordenada LOCAL, nao georreferencia: sem eles o');
    console.error('Cesium planta o modelo no centro da Terra. Nao ha como medir do arquivo.');
    process.exit(2);
  }
  if (Math.abs(o.lat) > 90 || Math.abs(o.lon) > 180) {
    console.error(`ERRO: lon=${o.lon} lat=${o.lat} fora do intervalo valido.`);
    process.exit(2);
  }

  const achado = achaGlb(o.origem);
  if (achado.erro) { console.error(`ERRO: ${achado.erro}`); process.exit(2); }

  const log = (s) => console.log(s);
  const passo = (t) => console.log(`\n--- ${t} ---`);

  const dbFilename = `${o.id}.3dtiles`;
  const destino = join(config.modelsDbDir, dbFilename);
  const temporario = `${destino}.parcial`;

  getIndexDb();
  const jaExiste = getModelAny(o.id);
  if (jaExiste && !o.forcar) {
    console.error(`ERRO: o modelo "${o.id}" ja esta no catalogo (importado em ${jaExiste.built_at}).`);
    console.error('Use --forcar para reimportar por cima.');
    closeAll();
    process.exit(3);
  }

  passo('1. leitura do arquivo');
  const bruto = readFileSync(achado.arquivo);
  const bytesEntrada = bruto.length;
  log(`  ${basename(achado.arquivo)}  ${(bytesEntrada / 2 ** 20).toFixed(2)} MiB`);

  let envelope;
  try {
    envelope = abrirTile(bruto);
  } catch (err) {
    console.error(`ERRO: ${err.message}`);
    closeAll();
    process.exit(4);
  }
  const gerador = leGerador(envelope.glb);
  const naoSuportadas = extensoesNaoSuportadas(envelope.glb);
  log(`  motor: ${gerador || 'desconhecido'}`);
  if (naoSuportadas.length) {
    console.error('ERRO: o arquivo declara extensao que esta conversao nao trata:');
    for (const e of naoSuportadas) console.error(`  ${e}`);
    closeAll();
    process.exit(4);
  }
  log(`  onde plantar: lon ${o.lon} lat ${o.lat} altura ${o.altura} m`);
  log(`  orientacao: heading ${o.heading} pitch ${o.pitch} roll ${o.roll}   escala ${o.escala}`);

  const ktxVersao = await versaoKtx();

  if (o.dryRun) {
    log('\n--dry-run: nada foi escrito.');
    closeAll();
    return;
  }

  passo('2. banco de destino');
  if (!existsSync(config.modelsDbDir)) mkdirSync(config.modelsDbDir, { recursive: true });
  closeModelDb(dbFilename);
  for (const f of [temporario, `${temporario}-wal`, `${temporario}-shm`]) {
    if (existsSync(f)) unlinkSync(f);
  }
  const db = createModelDb(temporario);

  const token = `${Date.now().toString(36)}`;
  const importId = openImport(o.id, achado.arquivo);

  passo(`3. conversao (geometria=${o.geometria}, qlevel=${o.qlevel}, ${ktxVersao})`);
  const t0 = Date.now();
  // upAxis fica em 'Y': um glb solto e Y-up por definicao do proprio glTF, e
  // nao ha `asset.gltfUpAxis` (isso e campo de tileset, e aqui nao ha tileset).
  const conversor = await criarConversor({
    geometria: o.geometria, upAxis: 'Y', maxTextura: o.maxTextura,
  });
  let r;
  try {
    r = await conversor.converte(bruto, o.qlevel);
  } finally {
    conversor.fecha();
  }
  const segundos = (Date.now() - t0) / 1000;
  log(`  ${(bytesEntrada / 2 ** 20).toFixed(2)} -> ${(r.glb.length / 2 ** 20).toFixed(2)} MiB`
    + `  (razao ${(r.glb.length / bytesEntrada).toFixed(4)})  em ${segundos.toFixed(1)} s`);
  log(`  texturas ${r.texturas}   triangulos ${(r.triangulos || 0).toLocaleString('pt-BR')}`);
  if (r.falhas) log(`  ATENCAO: ${r.falhas} texturas nao converteram`);

  db.prepare('INSERT OR REPLACE INTO media (key, content) VALUES (?, ?)').run(CHAVE, r.glb);

  passo('4. conferencia');
  const lido = db.prepare('SELECT content FROM media WHERE key = ?').get(CHAVE);
  // A CONFERENCIA COBRE A EXTENSAO DA ESCRITA, e aqui a escrita e um objeto so:
  // comparar o tamanho nao basta, entao ela releva o BLOB inteiro do destino e
  // o compara byte a byte com o que foi gravado.
  if (!lido || !lido.content.equals(r.glb)) {
    console.error('ERRO: o BLOB relido do banco nao bate com o convertido.');
    finalizarModelDb(db);
    closeImport({
      id: importId, finished_at: new Date().toISOString(), status: 'falhou',
      tiles_in: 1, tiles_out: 0, textures: r.texturas, failures: r.falhas,
      seconds: segundos, ratio: null, notes: 'releitura do BLOB divergiu',
    });
    closeAll();
    process.exit(5);
  }
  const total = db.prepare('SELECT COUNT(*) AS n FROM media').get().n;
  log(`  entradas no banco ${total} (esperado 1)   BLOB relido confere byte a byte`);

  passo('5. fecho do banco');
  const meta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  db.transaction(() => {
    meta.run('id', o.id);
    meta.run('name', o.nome || o.id);
    meta.run('modelType', 'glb');
    meta.run('geometry', o.geometria);
    meta.run('texture', 'ktx2-etc1s');
    meta.run('textureQuality', String(o.qlevel));
    meta.run('buildToken', token);
    meta.run('builtAt', new Date().toISOString());
    meta.run('sourcePath', achado.arquivo);
    meta.run('ktx', ktxVersao);
    // `tileCount` e `sourceBytes` sao o contrato do cabecalho, e o `adotar.js`
    // os exige: sem eles um `.3dtiles` em disco nao volta ao catalogo sem
    // reconverter. Aqui o modelo e UM objeto, e a contagem e 1.
    meta.run('tileCount', '1');
    meta.run('jsonCount', '0');
    meta.run('sourceBytes', String(bytesEntrada));
    meta.run('lon', String(o.lon));
    meta.run('lat', String(o.lat));
    meta.run('height', String(o.altura));
    meta.run('published', '1');
    meta.run('positionLon', String(o.lon));
    meta.run('positionLat', String(o.lat));
  })();
  finalizarModelDb(db);

  const bytesFinal = trocaArquivo({
    temporario, destino, dbFilename, importId, log, roteiro: 'scripts/importar-glb.js',
    conv: { tentados: 1, convertidos: 1, texturas: r.texturas, falhasTextura: r.falhas, segundos },
  });
  log(`  ${dbFilename}  ${(bytesFinal / 2 ** 20).toFixed(2)} MiB`);

  passo('6. catalogo');
  upsertModel({
    id: o.id,
    name: o.nome || o.id,
    db_filename: dbFilename,
    source: gerador,
    source_version: null,
    captured_at: null,
    tiles_version: '1.1',
    geometry_codec: o.geometria,
    texture_codec: 'ktx2-etc1s',
    texture_quality: o.qlevel,
    tile_count: 1,
    json_count: 0,
    total_bytes: bytesFinal,
    source_bytes: bytesEntrada,
    build_token: token,
    built_at: new Date().toISOString(),
    // O PONTO DE NAVEGACAO E O DE PLANTIO SAO O MESMO AQUI. Num modelo de
    // arvore eles diferem, porque o envelope mede o conjunto; num objeto unico
    // nao ha o que medir, e voar para onde ele esta e o comportamento certo.
    lon: o.lon,
    lat: o.lat,
    height: o.altura + 300,
    ground_height: null,
    min_height: null,
    height_offset: o.altura,
    max_sse: null,
    model_type: 'glb',
    position_lon: o.lon,
    position_lat: o.lat,
    rot_heading: o.heading,
    rot_pitch: o.pitch,
    rot_roll: o.roll,
    scale: o.escala,
    description: null,
    local: null,
    keywords: null,
    preview_video: null,
    preview_thumb: null,
    published: 1,
  });
  closeImport({
    id: importId,
    finished_at: new Date().toISOString(),
    status: 'ok',
    tiles_in: 1,
    tiles_out: 1,
    textures: r.texturas,
    failures: r.falhas,
    seconds: segundos,
    ratio: bytesFinal / bytesEntrada,
    notes: null,
  });

  log(`\n=== IMPORTADO: ${o.id} (glb) ===`);
  log(`URL para o ebgeo_web: /api/v1/models/${o.id}/${CHAVE}`);
  closeAll();
}

main().catch((err) => {
  console.error(err);
  closeAll();
  process.exit(1);
});
