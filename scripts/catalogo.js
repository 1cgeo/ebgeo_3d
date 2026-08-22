#!/usr/bin/env node

/**
 * @module scripts/catalogo
 * @description Imprime o catalogo pronto para colar no `config.tilesets` do
 * ebgeo_web, ou a tabela do acervo.
 *
 * Uso:
 *   node scripts/catalogo.js                       # tabela
 *   node scripts/catalogo.js --js --base /ebgeo_3d  # trecho para o config.js
 *   node scripts/catalogo.js --js --sem-terreno     # idem, para cliente sem terreno
 *
 * `--sem-terreno` publica heightOffset = -min_height em vez do valor do
 * catalogo. Um Cesium que nao consegue carregar o terreno cai EM SILENCIO para
 * o EllipsoidTerrainProvider: o chao vira liso na altura 0 e todo modelo passa
 * a flutuar a propria altura elipsoidal. Use so na maquina que esta nesse
 * estado, e NUNCA para gerar o config de producao.
 */

import { listModels, getTotals } from '../src/db/queries.js';
import { getIndexDb, closeAll } from '../src/db/connection.js';

function args() {
  const a = process.argv.slice(2);
  const v = (n, p) => { const i = a.indexOf(n); return i >= 0 && a[i + 1] ? a[i + 1] : p; };
  return {
    js: a.includes('--js'),
    semTerreno: a.includes('--sem-terreno'),
    base: v('--base', '/ebgeo_3d').replace(/\/+$/, ''),
  };
}

const o = args();
getIndexDb();
const modelos = listModels();

if (o.js) {
  const entradas = modelos.map((m) => {
    const e = {
      url: `${o.base}/api/v1/models/${m.id}/tileset.json`,
      id: m.id,
      name: m.name,
      // `-min_height`, E NAO `-ground_height`. Descer o modelo pela MEDIANA das
      // alturas poe a parte baixa dele ABAIXO do chao liso, o globo a corta por
      // dentro, e as duas superficies brigam pelo mesmo pixel. Medido no Silo:
      // com -62,3 a base caia a -22,8 m, e o chefe viu o efeito na tela.
      // Pelo minimo, nada do modelo afunda.
      heightOffset: (o.semTerreno && m.min_height != null)
        ? -Number(m.min_height.toFixed(1))
        : (m.height_offset ?? 0),
    };
    if (m.ground_height != null) e.groundHeight = +m.ground_height.toFixed(1);
    if (m.min_height != null) e.minHeight = +m.min_height.toFixed(1);
    if (m.description) e.description = m.description;
    if (m.local) e.local = m.local;
    if (m.captured_at) e.data_captura = m.captured_at;
    if (m.keywords) { try { e.keywords = JSON.parse(m.keywords); } catch { /* ignora */ } }
    if (m.lon != null) e.locate = { lon: m.lon, lat: m.lat, height: m.height ?? 1000 };
    if (m.max_sse != null && m.max_sse !== 16) e.maximumScreenSpaceError = m.max_sse;
    return e;
  });
  console.log('// gerado por scripts/catalogo.js --js'
    + (o.semTerreno ? ' --sem-terreno (heightOffset = -min_height)' : ''));
  console.log(`tilesets: ${JSON.stringify(entradas, null, 2)},`);
} else {
  const { bytes, tiles } = getTotals();
  console.log(`${'id'.padEnd(28)} ${'tiles'.padStart(9)} ${'MiB'.padStart(9)} ${'fmt'.padEnd(18)} ${'token'.padEnd(10)} nav`);
  for (const m of modelos) {
    console.log(
      `${m.id.padEnd(28)} ${m.tile_count.toLocaleString('pt-BR').padStart(9)} `
      + `${(m.total_bytes / 2 ** 20).toFixed(1).padStart(9)} `
      + `${`${m.geometry_codec}+${m.texture_codec}`.padEnd(18)} `
      + `${(m.build_token || '').padEnd(10)} `
      + `${m.lon != null ? `${m.lon.toFixed(4)},${m.lat.toFixed(4)}` : 'SEM PONTO'}`
      + `${m.ground_height != null ? ` chao ${m.ground_height.toFixed(1)}` : ''}`
      + `${m.min_height != null ? ` base ${m.min_height.toFixed(1)} m` : ''}`,
    );
  }
  console.log(`\n${modelos.length} modelos, ${tiles.toLocaleString('pt-BR')} tiles, ${(bytes / 2 ** 30).toFixed(2)} GiB`);
}

closeAll();
