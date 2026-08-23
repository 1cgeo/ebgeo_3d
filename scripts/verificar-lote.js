#!/usr/bin/env node

/**
 * @module scripts/verificar-lote
 * @description Confere UM A UM os `.3dtiles` que o lote produziu, contra a
 * origem que os gerou.
 *
 * POR QUE NAO BASTA O `verificar.js`. Aquele confere UM modelo que esta no
 * catalogo e no diretorio de dados do servico. O lote MOVE o produto para o HD
 * externo e apaga do PC, entao o catalogo local aponta para arquivo que nao
 * esta mais la. A pergunta aqui e outra: o que foi parar no HD esta inteiro?
 *
 * A CONFERENCIA COBRE A MESMA EXTENSAO DA ESCRITA. Converteu N tiles, confere os
 * N; publicou M referencias, resolve as M. Amostragem entra so na leitura do
 * CONTEUDO de tile, que exige decodificar, e ali o tamanho da amostra sai
 * escrito no relatorio.
 *
 * Uso:
 *   node scripts/verificar-lote.js --destino D:/modelos_3d_convertidos
 *   node scripts/verificar-lote.js --destino ... --origem D:/modelos_3d
 *   node scripts/verificar-lote.js --destino ... --id 3rcc --amostra 500
 *   node scripts/verificar-lote.js --destino ... --relatorio saida.json
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, extname, sep } from 'node:path';
import Database from 'better-sqlite3';
import { envelopeGeodesico } from './lib/tileset.js';
import { comparaComOrigem } from './lib/copia.js';

function args() {
  const a = process.argv.slice(2);
  const v = (n, p) => { const i = a.indexOf(n); return i >= 0 && a[i + 1] ? a[i + 1] : p; };
  return {
    destino: v('--destino', ''),
    origem: v('--origem', process.env.EBGEO3D_SOURCE_DIR || ''),
    id: v('--id', null),
    amostra: parseInt(v('--amostra', '120'), 10),
    relatorio: v('--relatorio', null),
    quieto: a.includes('--quieto'),
  };
}

const o = args();
if (!o.destino) {
  console.error('Uso: node scripts/verificar-lote.js --destino <pasta> [--origem <pasta>]');
  process.exit(2);
}

/** Resolve uma uri relativa contra o diretorio do tileset que a cita. */
function resolveChave(base, uri) {
  const partes = [];
  for (const p of `${base ? `${base}/` : ''}${uri}`.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') { partes.pop(); continue; }
    partes.push(p);
  }
  return partes.join('/');
}

/** Conta TUDO que ha na arvore, tolerando erro de leitura do HD. */
function contaTudo(raiz) {
  let tiles = 0;
  let jsons = 0;
  let erros = 0;
  (function anda(dir) {
    let entradas;
    try { entradas = readdirSync(dir, { withFileTypes: true }); } catch { erros++; return; }
    for (const e of entradas) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { anda(p); continue; }
      const ext = extname(e.name).toLowerCase();
      if (ext === '.b3dm' || ext === '.glb') tiles++;
      else if (ext === '.json') jsons++;
    }
  })(raiz);
  return { tiles, jsons, erros };
}

/**
 * Conta os tiles que o `tileset.json` da raiz ALCANCA, e nao os que estao na
 * pasta.
 *
 * POR QUE A DISTINCAO IMPORTA. O `estrela-merge` carrega uma pasta
 * `estrela0-antigo` que a raiz nao referencia: 94.034 tiles que ninguem le.
 * Contando por diretorio, a origem tem 246.821 tiles e o produto 152.787, e a
 * conferencia reprovava um modelo correto a cada passagem. Falso alarme
 * permanente e pior que alarme nenhum, porque ensina a ignorar o alarme.
 *
 * A travessia segue as uris a partir da raiz. Uri de `.json` e tileset externo,
 * e entra na recursao; o resto e tile. O `visitados` corta ciclo.
 *
 * Quando a raiz nao tem `tileset.json` (o GLB solto), cai na contagem por
 * diretorio, que ali e a medida certa.
 */
function contaAlcancavel(raiz) {
  const tileset = join(raiz, 'tileset.json');
  if (!existsSync(tileset)) {
    const t = contaTudo(raiz);
    return { ...t, total: t.tiles, orfaos: 0, porArvore: false };
  }

  const tiles = new Set();
  const visitados = new Set();
  let erros = 0;
  let jsons = 0;

  (function anda(rel) {
    if (visitados.has(rel)) return;
    visitados.add(rel);
    jsons += 1;
    let j;
    try { j = JSON.parse(readFileSync(join(raiz, rel), 'utf-8')); } catch { erros += 1; return; }
    const base = dirname(rel) === '.' ? '' : dirname(rel).split(sep).join('/');
    (function no(n) {
      if (!n || typeof n !== 'object') return;
      const u = n.content?.uri || n.content?.url;
      if (u) {
        const chave = resolveChave(base, u);
        if (chave.toLowerCase().endsWith('.json')) anda(chave.split('/').join(sep));
        else tiles.add(chave);
      }
      for (const c of n.children || []) no(c);
    })(j.root || {});
  })('tileset.json');

  const todos = contaTudo(raiz);
  return {
    tiles: tiles.size,
    total: todos.tiles,
    jsons,
    erros: erros + todos.erros,
    orfaos: todos.tiles - tiles.size,
    porArvore: true,
  };
}

/**
 * Confere um `.3dtiles`. Devolve a lista de problemas: vazia significa aprovado.
 */
function confere(caminho, pastaOrigem) {
  const problemas = [];
  const fatos = {};
  let db;
  try {
    db = new Database(caminho, { readonly: true });
  } catch (err) {
    // ERRO DE DISCO NAO E VEREDITO SOBRE O DADO. Em 2026-08-23 o HD caiu no
    // meio de uma passagem e os 11 modelos seguintes sairam como reprovados,
    // todos com `disk I/O error`, todos intactos. Onze alarmes falsos em
    // cascata desmoralizam a conferencia inteira: quem le passa a duvidar
    // tambem dos verdadeiros.
    const disco = /disk I\/O error|EIO|UNKNOWN|ENOENT|EBUSY/i.test(err.message);
    return { problemas: [`nao abre como SQLite: ${err.message}`], fatos, erroDeDisco: disco };
  }

  try {
    // 1. INTEGRIDADE DO ARQUIVO. Um .3dtiles truncado na copia para o HD abre,
    //    responde consulta e so falha no tile que caiu no pedaco perdido.
    const integridade = db.pragma('integrity_check', { simple: true });
    if (integridade !== 'ok') problemas.push(`integrity_check: ${integridade}`);

    // 2. CABECALHO. E o que permite o arquivo voltar ao catalogo sozinho.
    const meta = {};
    for (const r of db.prepare('SELECT key, value FROM meta').iterate()) meta[r.key] = r.value;
    fatos.token = meta.buildToken;
    fatos.builtAt = meta.builtAt;
    for (const k of ['id', 'buildToken', 'builtAt', 'tileCount']) {
      if (!meta[k]) problemas.push(`cabecalho sem ${k}`);
    }

    // 3. CONTAGEM: banco contra cabecalho.
    const tiles = db.prepare("SELECT COUNT(*) AS n FROM media WHERE key LIKE '%.glb'").get().n;
    const jsons = db.prepare("SELECT COUNT(*) AS n FROM media WHERE key LIKE '%.json'").get().n;
    fatos.tiles = tiles;
    fatos.jsons = jsons;
    if (meta.tileCount && Number(meta.tileCount) !== tiles) {
      problemas.push(`cabecalho diz ${meta.tileCount} tiles, banco tem ${tiles}`);
    }

    // 4. O tileset de raiz existe e e 1.1.
    const raiz = db.prepare('SELECT content FROM media WHERE key = ?').get('tileset.json');
    if (!raiz) {
      problemas.push('sem tileset.json na raiz');
    } else {
      let j;
      try { j = JSON.parse(raiz.content.toString('utf-8')); } catch { j = null; }
      if (!j) problemas.push('tileset.json da raiz nao e JSON valido');
      else if (j.asset?.version !== '1.1') problemas.push(`asset.version = ${j.asset?.version}`);
    }

    // 5. TODA REFERENCIA RESOLVE. Nao e amostra: uma uri orfa e um pedaco do
    //    modelo que nunca aparece, e o Cesium trata 404 como tile vazio.
    const docs = new Map();
    for (const r of db.prepare("SELECT key, content FROM media WHERE key LIKE '%.json'").iterate()) {
      try { docs.set(r.key, JSON.parse(r.content.toString('utf-8'))); } catch {
        problemas.push(`${r.key} nao e JSON valido`);
      }
    }
    const temChave = db.prepare('SELECT 1 FROM media WHERE key = ?');
    let referencias = 0;
    const quebradas = [];
    for (const [chave, doc] of docs) {
      const corte = chave.lastIndexOf('/');
      const base = corte < 0 ? '' : chave.slice(0, corte);
      (function anda(t) {
        if (!t || typeof t !== 'object') return;
        const cs = [];
        if (t.content) cs.push(t.content);
        if (Array.isArray(t.contents)) cs.push(...t.contents);
        for (const c of cs) {
          const uri = String(c?.uri || '').split('?')[0];
          if (!uri || /^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.startsWith('//')) continue;
          referencias++;
          const alvo = resolveChave(base, uri);
          if (!temChave.get(alvo)) quebradas.push(alvo);
        }
        if (Array.isArray(t.children)) for (const f of t.children) anda(f);
      })(doc.root);
    }
    fatos.referencias = referencias;
    if (quebradas.length) {
      problemas.push(`${quebradas.length} referencias quebradas: ${quebradas.slice(0, 3).join(', ')}`);
    }

    // 6. O CONTEUDO E MESMO glTF, e traz a receita. Aqui a amostra e inevitavel,
    //    e o tamanho dela sai no relatorio.
    const chaves = db.prepare("SELECT key FROM media WHERE key LIKE '%.glb' ORDER BY key").all().map((r) => r.key);
    const passo = Math.max(1, Math.floor(chaves.length / o.amostra));
    let lidos = 0;
    let semDraco = 0;
    let semKtx = 0;
    let semTextura = 0;
    let maiorTextura = 0;
    const naoGltf = [];
    for (let i = 0; i < chaves.length; i += passo) {
      const buf = db.prepare('SELECT content FROM media WHERE key = ?').get(chaves[i]).content;
      if (buf.length < 20 || buf.toString('ascii', 0, 4) !== 'glTF') { naoGltf.push(chaves[i]); continue; }
      lidos++;
      const nJson = buf.readUInt32LE(12);
      let j;
      try { j = JSON.parse(buf.toString('utf-8', 20, 20 + nJson)); } catch { naoGltf.push(chaves[i]); continue; }
      const ext = j.extensionsUsed || [];
      const temMalha = (j.meshes || []).length > 0;
      if (temMalha && !ext.includes('KHR_draco_mesh_compression')) semDraco++;
      const imagens = j.images || [];
      if (imagens.length === 0) semTextura++;
      else if (!ext.includes('KHR_texture_basisu')) semKtx++;
      // dimensao das texturas, para provar o teto
      const inicioBin = 20 + nJson + 8;
      for (const im of imagens) {
        if (im.bufferView == null) continue;
        const bv = j.bufferViews[im.bufferView];
        const off = inicioBin + (bv.byteOffset || 0);
        if (off + 44 > buf.length) continue;
        maiorTextura = Math.max(maiorTextura, buf.readUInt32LE(off + 20), buf.readUInt32LE(off + 24));
      }
    }
    fatos.amostraLida = lidos;
    fatos.maiorTextura = maiorTextura;
    if (naoGltf.length) problemas.push(`${naoGltf.length} tiles da amostra nao sao glTF: ${naoGltf.slice(0, 2).join(', ')}`);
    if (semDraco) problemas.push(`${semDraco} tiles com malha e SEM Draco`);
    if (semKtx) problemas.push(`${semKtx} tiles com imagem e SEM KTX2`);
    fatos.semTextura = semTextura;

    // 7. O MODELO TEM LUGAR. Sem envelope ele nao ganha ponto de navegacao, e o
    //    catalogo nao sabe para onde voar.
    const env = envelopeGeodesico(docs);
    if (!env) problemas.push('o envelope geodesico nao fecha (sem box de conteudo)');
    else {
      fatos.lon = +env.lon.toFixed(6);
      fatos.lat = +env.lat.toFixed(6);
      fatos.chao = +env.hChao.toFixed(1);
      if (Math.abs(env.lat) < 0.5 && Math.abs(env.lon) < 0.5) {
        problemas.push(`ponto no golfo da Guine (${fatos.lon}, ${fatos.lat}): transform ignorado`);
      }
    }

    // 8. CONTRA A ORIGEM, quando ela responde.
    if (pastaOrigem && existsSync(pastaOrigem)) {
      const org = contaAlcancavel(pastaOrigem);
      fatos.tilesOrigem = org.tiles;
      if (org.erros) fatos.errosLeituraOrigem = org.erros;
      // Tile que a raiz nao alcanca nao e do modelo, e nao entra na conta. Ele
      // sai como FATO, para a pasta orfa aparecer sem virar reprovacao.
      if (org.orfaos > 0) fatos.tilesForaDaArvore = org.orfaos;

      // A regra que julga esta em `lib/copia.js`, com teste. Ela e assimetrica
      // porque a contagem da origem e um PISO quando a travessia tropeca.
      const v = comparaComOrigem(tiles, org);
      if (v.problema) problemas.push(v.problema);
      if (v.fato) fatos.origemIncompleta = v.fato;
    }
  } finally {
    db.close();
  }

  return { problemas, fatos };
}

// ---------------------------------------------------------------- corrida

if (!existsSync(o.destino)) {
  console.error(`ERRO: destino nao responde: ${o.destino}`);
  process.exit(2);
}

const arquivos = readdirSync(o.destino)
  .filter((f) => f.endsWith('.3dtiles'))
  .filter((f) => !o.id || f === `${o.id}.3dtiles`)
  .sort();

console.log(`conferindo ${arquivos.length} modelos em ${o.destino}`);
console.log(`amostra de conteudo: ate ${o.amostra} tiles por modelo\n`);

const relatorio = [];
let aprovados = 0;
let reprovados = 0;

for (const arquivo of arquivos) {
  const id = arquivo.replace(/\.3dtiles$/, '');
  const caminho = join(o.destino, arquivo);
  const bytes = statSync(caminho).size;
  // O nome da pasta de origem nem sempre e o id (o lote normaliza), entao ele
  // sai do cabecalho quando esta la.
  let pastaOrigem = null;
  if (o.origem) {
    try {
      const db = new Database(caminho, { readonly: true });
      const sp = db.prepare("SELECT value FROM meta WHERE key = 'sourcePath'").get();
      db.close();
      if (sp?.value) {
        const nome = sp.value.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
        const candidato = join(o.origem, nome);
        if (existsSync(candidato)) pastaOrigem = candidato;
      }
    } catch { /* sem cabecalho legivel: a comparacao com a origem fica de fora */ }
  }

  const { problemas, fatos, erroDeDisco } = confere(caminho, pastaOrigem);
  if (erroDeDisco) {
    console.error(`
PARADO em ${id}: o disco recusou a leitura (${problemas[0]}).`);
    console.error('Nada se conclui sobre este modelo nem sobre os seguintes.');
    console.error(`Conferidos ate aqui: ${relatorio.length}. Rode de novo com o disco de pe.`);
    process.exitCode = 3;
    break;
  }
  const linha = {
    id, bytes, aprovado: problemas.length === 0, problemas, ...fatos,
    origemConferida: Boolean(pastaOrigem),
  };
  relatorio.push(linha);

  if (problemas.length === 0) {
    aprovados++;
    if (!o.quieto) {
      console.log(`OK   ${id.padEnd(30)} ${(bytes / 2 ** 20).toFixed(0).padStart(6)} MiB`
        + ` ${String(fatos.tiles).padStart(7)} tiles`
        + ` ${String(fatos.referencias).padStart(7)} refs`
        + `  tex<=${fatos.maiorTextura}`
        + (pastaOrigem ? '  origem OK' : '  (sem origem)'));
    }
  } else {
    reprovados++;
    console.log(`FALHA ${id.padEnd(29)} ${(bytes / 2 ** 20).toFixed(0).padStart(6)} MiB`);
    for (const p of problemas) console.log(`      ${p}`);
  }
}

console.log(`\n${aprovados} aprovados, ${reprovados} reprovados`);
const somaBytes = relatorio.reduce((s, r) => s + r.bytes, 0);
const somaTiles = relatorio.reduce((s, r) => s + (r.tiles || 0), 0);
console.log(`${somaTiles.toLocaleString('pt-BR')} tiles, ${(somaBytes / 2 ** 30).toFixed(2)} GiB`);
const semOrigem = relatorio.filter((r) => !r.origemConferida).length;
if (semOrigem) console.log(`${semOrigem} sem comparacao com a origem (pasta nao achada)`);

if (o.relatorio) {
  writeFileSync(o.relatorio, JSON.stringify(relatorio, null, 2), 'utf-8');
  console.log(`relatorio em ${o.relatorio}`);
}

process.exit(reprovados ? 1 : 0);
