#!/usr/bin/env node

/**
 * @module scripts/remedir
 * @description Remede o ponto de navegacao e a altura do chao de modelos JA
 * publicados, lendo o .3dtiles em vez de reconverter.
 *
 * Existe por causa de um defeito real: ate 2026-08-22 o importador so sabia ler
 * o ponto de `properties` ou de `boundingVolume.region`. O DJI Terra nao publica
 * nenhum dos dois, entao o ponto entrava a mao no catalogo, e o Silo Oreste
 * Ceretta ficou 3,6 km ao sul do lugar dele. `envelopeGeodesico` mede.
 *
 * Reconverter o modelo inteiro para consertar um metadado custaria horas: este
 * roteiro le os tileset.json ja gravados, que sao os mesmos, e so escreve no
 * catalogo.
 *
 * Uso:
 *   node scripts/remedir.js                 # todos os modelos
 *   node scripts/remedir.js silo-dona-francisca
 *   node scripts/remedir.js --dry-run
 */

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import config from '../src/config.js';
import { getIndexDb, closeAll } from '../src/db/connection.js';
import { envelopeGeodesico } from './lib/tileset.js';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const alvos = argv.filter((a) => !a.startsWith('--'));

const db = getIndexDb();
const linhas = alvos.length
  ? alvos.map((id) => db.prepare('SELECT * FROM models WHERE id = ?').get(id) || { id, ausente: true })
  : db.prepare('SELECT * FROM models ORDER BY id').all();

const atualiza = db.prepare(`
  UPDATE models SET lon = ?, lat = ?, height = ?, ground_height = ? WHERE id = ?
`);

let mudados = 0;
for (const m of linhas) {
  if (m.ausente) { console.error(`AUSENTE no catalogo: ${m.id}`); continue; }
  const caminho = join(config.modelsDbDir, m.db_filename);
  if (!existsSync(caminho)) { console.error(`AUSENTE em disco: ${m.db_filename}`); continue; }

  const mdb = new Database(caminho, { readonly: true });
  const docs = new Map();
  for (const r of mdb.prepare("SELECT key, content FROM media WHERE key LIKE '%.json'").iterate()) {
    docs.set(r.key, JSON.parse(r.content.toString('utf-8')));
  }
  mdb.close();

  const e = envelopeGeodesico(docs);
  if (!e) { console.error(`${m.id}: o envelope nao fechou (nenhum box de conteudo)`); continue; }

  // A distancia entre o ponto do catalogo e o medido e o que denuncia o erro.
  const dist = (m.lon != null && m.lat != null)
    ? Math.round(Math.hypot(
      (e.lon - m.lon) * 111320 * Math.cos((e.lat * Math.PI) / 180),
      (e.lat - m.lat) * 111320))
    : null;

  console.log(`${m.id}`);
  console.log(`  catalogo  lon ${fmt(m.lon)} lat ${fmt(m.lat)} h ${fmt(m.height)} chao ${fmt(m.ground_height)}`);
  console.log(`  medido    lon ${e.lon.toFixed(7)} lat ${e.lat.toFixed(7)} h ${(e.hChao + 500).toFixed(1)} chao ${e.hChao.toFixed(1)}`);
  console.log(`  envelope  ${e.hMin.toFixed(1)} a ${e.hMax.toFixed(1)} m, raio ${Math.round(e.raio)} m, ${e.amostras.toLocaleString('pt-BR')} cantos`);
  if (dist != null) console.log(`  ${dist > 50 ? 'DESLOCADO' : 'desloca'} ${dist.toLocaleString('pt-BR')} m`);

  if (!dryRun) {
    atualiza.run(e.lon, e.lat, e.hChao + 500, e.hChao, m.id);
    mudados++;
  }
}

console.log(dryRun ? '\n--dry-run: nada gravado' : `\n${mudados} modelos atualizados no catalogo`);
closeAll();

function fmt(v) { return v == null ? '(vazio)' : Number(v).toFixed(7).replace(/0+$/, '0'); }
