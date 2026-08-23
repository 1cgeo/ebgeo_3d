#!/usr/bin/env node

/**
 * @module scripts/cruzar-acervo
 * @description Cruza a arvore de ORIGEM com a de CONVERTIDOS e diz, para cada
 * modelo que nao atravessou, POR QUE.
 *
 * POR QUE NAO BASTA O `lote.json`. Aquele guarda o que a corrida VIU: o que ela
 * terminou e o que falhou nela. Ele nao sabe o que nunca chegou a ser tentado,
 * nem o que existe na origem e nao e modelo, nem o que apareceu no destino sem
 * origem. Este roteiro pergunta aos DOIS DISCOS, e usa o estado so para
 * enriquecer a resposta.
 *
 * A CAUSA SE DIAGNOSTICA NA ORIGEM, e nao se copia do registro de falha. Um
 * modelo pode constar como falho por um motivo e ter, alem disso, um defeito
 * que ninguem viu porque a corrida parou antes.
 *
 * Uso:
 *   node scripts/cruzar-acervo.js --origem D:/modelos_3d --destino D:/modelos_3d_convertidos
 *   node scripts/cruzar-acervo.js --destino ... --json relatorio.json
 */

import { existsSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';

function args() {
  const a = process.argv.slice(2);
  const v = (n, p) => { const i = a.indexOf(n); return i >= 0 && a[i + 1] ? a[i + 1] : p; };
  return {
    origem: v('--origem', process.env.EBGEO3D_SOURCE_DIR || ''),
    destino: v('--destino', ''),
    estado: v('--estado', join(process.cwd(), 'data', 'lote.json')),
    json: v('--json', null),
  };
}

const o = args();
if (!o.origem || !o.destino) {
  console.error('Uso: node scripts/cruzar-acervo.js --origem <pasta> --destino <pasta>');
  process.exit(2);
}

/** Mesma normalizacao que o lote usa para virar id. */
function paraId(pasta) {
  return pasta.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
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

/**
 * Diagnostica um modelo da ORIGEM, sem converter nada.
 *
 * Le so os `.json` da arvore, seguindo as referencias. Varrer os `.b3dm` custa
 * milhoes de `stat` no HD externo, e ja o derrubou uma vez.
 */
function diagnostica(pasta) {
  const arquivos = readdirSync(pasta);
  const temTileset = arquivos.includes('tileset.json');
  const glbs = arquivos.filter((f) => extname(f).toLowerCase() === '.glb');

  if (!temTileset) {
    if (glbs.length === 1) {
      return {
        tipo: 'glb',
        causa: 'GLB solto: precisa de --lon e --lat, que o arquivo nao carrega',
        acao: 'node scripts/importar-glb.js --origem <pasta> --id <slug> --lon N --lat N',
      };
    }
    if (glbs.length > 1) {
      return { tipo: 'ambiguo', causa: `${glbs.length} arquivos .glb soltos e nenhum tileset.json`, acao: 'aponte um .glb a mao' };
    }
    // CENA NAVEGAVEL A PE, e nao "nao e modelo". O layout dela e outro: o splat
    // em `cena.sog`, o octree em `voxel/`, e nenhum tileset.json. Chamar isso de
    // "nao e modelo 3D" mandaria o operador ignorar acervo de verdade.
    if (arquivos.includes('cena.sog') || arquivos.includes('voxel')) {
      return {
        tipo: 'cena',
        causa: 'cena navegavel a pe (Gaussian Splatting): outro roteiro, e ela NAO vira .3dtiles',
        acao: 'node scripts/importar-cena.js --origem <pasta> --id <slug> --nome "..."',
      };
    }

    // MODELO UM NIVEL ABAIXO. O `area_12_havan_lajeado_estrela` guarda o modelo
    // dentro de uma subpasta, e o lote so olha a raiz: ele nem entrava na fila,
    // e o cruzamento o chamaria de "nao e modelo".
    const subpastas = arquivos.filter((f) => {
      try { return statSync(join(pasta, f)).isDirectory(); } catch { return false; }
    });
    const comTileset = subpastas.filter((sp) => existsSync(join(pasta, sp, 'tileset.json')));
    if (comTileset.length === 1) {
      return {
        tipo: 'aninhado',
        causa: `o modelo esta em ${comTileset[0]}/, e o lote so olha a raiz da pasta`,
        acao: `aponte a subpasta: --origem <pasta>/${comTileset[0]}`,
      };
    }
    if (comTileset.length > 1) {
      return {
        tipo: 'aninhado',
        causa: `${comTileset.length} modelos em subpastas: ${comTileset.slice(0, 4).join(', ')}`,
        acao: 'importe cada subpasta com um id proprio',
      };
    }

    return { tipo: 'nao-modelo', causa: 'sem tileset.json, sem .glb e sem cena.sog: nao e modelo 3D', acao: 'nada a fazer' };
  }

  // Segue a arvore de tileset.json, achando referencia quebrada e splatting.
  const faltando = [];
  const vazios = [];
  let splatting = false;
  let tilesReferenciados = 0;
  const fila = ['tileset.json'];
  const vistos = new Set();
  while (fila.length) {
    const rel = fila.pop();
    if (vistos.has(rel)) continue;
    vistos.add(rel);
    const caminho = join(pasta, rel.replace(/\//g, '\\'));
    if (!existsSync(caminho)) { faltando.push(rel); continue; }
    if (statSync(caminho).size === 0) { vazios.push(rel); continue; }
    let j;
    try { j = JSON.parse(readFileSync(caminho, 'utf-8')); } catch { vazios.push(rel); continue; }
    const corte = rel.lastIndexOf('/');
    const base = corte < 0 ? '' : rel.slice(0, corte);
    (function anda(t) {
      if (!t || typeof t !== 'object') return;
      const cs = [];
      if (t.content) cs.push(t.content);
      if (Array.isArray(t.contents)) cs.push(...t.contents);
      for (const c of cs) {
        const uri = String(c?.uri || '').split('?')[0];
        if (!uri) continue;
        if (uri.endsWith('.json')) fila.push(resolveChave(base, uri));
        else tilesReferenciados++;
      }
      if (Array.isArray(t.children)) for (const f of t.children) anda(f);
    })(j.root);
  }

  // Gaussian splatting: le UM tile, o suficiente para a extensao aparecer.
  const primeiroTile = (function acha(dir, prof = 0) {
    if (prof > 3) return null;
    let entradas;
    try { entradas = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of entradas) {
      if (!e.isDirectory()) {
        const ext = extname(e.name).toLowerCase();
        if (ext === '.glb' || ext === '.b3dm') return join(dir, e.name);
      }
    }
    for (const e of entradas) {
      if (e.isDirectory()) { const r = acha(join(dir, e.name), prof + 1); if (r) return r; }
    }
    return null;
  })(pasta);
  if (primeiroTile) {
    try {
      const buf = readFileSync(primeiroTile);
      const magico = buf.toString('ascii', 0, 4);
      const desloc = magico === 'b3dm' ? 28 : 0;
      if (buf.toString('ascii', desloc, desloc + 4) === 'glTF') {
        const nJson = buf.readUInt32LE(desloc + 12);
        const j = JSON.parse(buf.toString('utf-8', desloc + 20, desloc + 20 + nJson));
        const usadas = [...(j.extensionsUsed || []), ...(j.extensionsRequired || [])];
        splatting = usadas.some((e) => e.includes('gaussian_splatting'));
      }
    } catch { /* tile ilegivel: o diagnostico segue sem ele */ }
  }

  if (splatting) {
    return { tipo: 'splatting', causa: 'Gaussian splatting: a conversao destruiria os atributos do splat', acao: 'sirva a arvore como esta, ou trate o formato antes' };
  }
  if (faltando.length || vazios.length) {
    const quais = [...faltando.map((f) => `${f} (nao existe)`), ...vazios.map((f) => `${f} (vazio ou invalido)`)];
    return {
      tipo: 'origem-quebrada',
      causa: `${quais.length} tileset.json faltando ou ilegivel NA ORIGEM`,
      detalhe: quais.slice(0, 5),
      acao: 'procure o arquivo no backup, ou reprocesse o modelo na origem',
    };
  }
  return { tipo: 'ok', causa: null, tilesReferenciados };
}

// ---------------------------------------------------------------- cruzamento

let estado = { feitos: {}, falhas: {} };
try { estado = { ...estado, ...JSON.parse(readFileSync(o.estado, 'utf-8')) }; } catch { /* sem estado */ }

const noDestino = new Set(
  readdirSync(o.destino).filter((f) => f.endsWith('.3dtiles')).map((f) => f.replace(/\.3dtiles$/, '')),
);

const naOrigem = readdirSync(o.origem, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => ({ pasta: e.name, id: paraId(e.name) }));

console.log(`ORIGEM   ${naOrigem.length} pastas em ${o.origem}`);
console.log(`DESTINO  ${noDestino.size} arquivos em ${o.destino}\n`);

const ausentes = [];
const convertidos = [];
for (const m of naOrigem) {
  if (noDestino.has(m.id)) { convertidos.push(m); continue; }
  ausentes.push(m);
}

// O inverso: no destino sem origem. Denuncia pasta renomeada ou produto de teste.
const idsOrigem = new Set(naOrigem.map((m) => m.id));
const orfaos = [...noDestino].filter((id) => !idsOrigem.has(id));

console.log(`CONVERTIDOS  ${convertidos.length}`);
console.log(`AUSENTES     ${ausentes.length}\n`);

const relatorio = [];
const porTipo = new Map();

for (const m of ausentes) {
  let d;
  try {
    d = diagnostica(join(o.origem, m.pasta));
  } catch (err) {
    d = { tipo: 'ilegivel', causa: `nao deu para ler a origem: ${err.code || err.message}`, acao: 'o HD respondeu?' };
  }
  // O estado do lote ENRIQUECE, e nao substitui: ele diz se a corrida chegou a
  // tentar, e um modelo `ok` aqui que consta como falha la e outra historia.
  const falhaRegistrada = estado.falhas[m.id];
  const tentado = Boolean(falhaRegistrada);
  if (d.tipo === 'ok') {
    d = tentado
      ? { ...d, tipo: 'falha-de-corrida', causa: 'a origem esta inteira: a corrida falhou por outro motivo', acao: 'rode o lote de novo, que ele o pega' }
      : { ...d, tipo: 'na-fila', causa: 'a origem esta inteira e a corrida ainda nao chegou nele', acao: 'rode o lote de novo' };
  }
  const linha = { ...m, ...d, tentadoNaCorrida: tentado };
  if (falhaRegistrada) linha.registroDaCorrida = String(falhaRegistrada).trim().split('\n').pop().slice(0, 160);
  relatorio.push(linha);
  if (!porTipo.has(d.tipo)) porTipo.set(d.tipo, []);
  porTipo.get(d.tipo).push(linha);
}

const ORDEM = ['origem-quebrada', 'aninhado', 'splatting', 'cena', 'glb', 'ambiguo',
  'ilegivel', 'falha-de-corrida', 'na-fila', 'nao-modelo'];
for (const tipo of ORDEM) {
  const lista = porTipo.get(tipo);
  if (!lista) continue;
  console.log(`=== ${tipo.toUpperCase()} (${lista.length})`);
  for (const l of lista) {
    console.log(`  ${l.pasta}`);
    console.log(`    ${l.causa}`);
    if (l.detalhe) for (const d of l.detalhe) console.log(`      ${d}`);
    if (l.registroDaCorrida) console.log(`    a corrida registrou: ${l.registroDaCorrida}`);
    console.log(`    -> ${l.acao}`);
  }
  console.log();
}

if (orfaos.length) {
  console.log(`=== NO DESTINO SEM ORIGEM (${orfaos.length})`);
  for (const id of orfaos) console.log(`  ${id}  (pasta renomeada, ou produto de teste)`);
  console.log();
}

console.log(`${convertidos.length} de ${naOrigem.length} pastas da origem estao no destino`);
if (o.json) {
  writeFileSync(o.json, JSON.stringify({ convertidos: convertidos.length, ausentes: relatorio, orfaos }, null, 2), 'utf-8');
  console.log(`relatorio em ${o.json}`);
}
