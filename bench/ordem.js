#!/usr/bin/env node

/**
 * @module bench/ordem
 * @description Mede se a ORDEM FISICA das linhas no .3dtiles muda a leitura.
 *
 * A hipotese: a importacao insere os tiles na ordem em que varre o diretorio de
 * origem, e o SQLite grava o BLOB na ordem de rowid. O CesiumJS nao le nessa
 * ordem: ele desce a arvore e pede a VIZINHANCA do que a camera enxerga. Se as
 * duas ordens divergirem, cada tile pedido cai numa pagina distante da anterior,
 * e o disco paga por isso.
 *
 * O experimento monta duas copias do mesmo modelo, com os MESMOS pragmas e o
 * MESMO conteudo, mudando so a ordem de insercao:
 *
 *   atual      as linhas na ordem em que estao hoje (ordem de rowid)
 *   travessia  as linhas reinseridas na ordem em que o Cesium as descobre
 *
 * E le as duas na ordem de travessia, intercalando as rodadas.
 *
 * OS TRES CUIDADOS DO bench/banco.js VALEM AQUI, e pelos mesmos motivos:
 * rodadas intercaladas, coletor de lixo controlado e a MELHOR rodada em vez da
 * media. Ver o cabecalho daquele arquivo.
 *
 * A MEDIDA SO QUER DIZER ALGO COM O CACHE DE PAGINA FRIO. Um modelo de 300 MiB
 * cabe inteiro na memoria do sistema, e ali as duas ordens empatam por
 * construcao. O roteiro avisa quando o modelo cabe.
 *
 * Uso:
 *   node --expose-gc bench/ordem.js --modelo ponte-quatis
 *   node --expose-gc bench/ordem.js --modelo ponte-quatis --chaves 4000 --rodadas 9
 */

import { statSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { totalmem } from 'node:os';
import Database from 'better-sqlite3';
import config from '../src/config.js';

function args() {
  const a = process.argv.slice(2);
  const v = (n, p) => { const i = a.indexOf(n); return i >= 0 && a[i + 1] ? a[i + 1] : p; };
  return {
    modelo: v('--modelo', 'ponte-quatis'),
    chaves: Number(v('--chaves', 4000)),
    rodadas: Number(v('--rodadas', 9)),
    manter: a.includes('--manter'),
  };
}

const o = args();
const origem = join(config.modelsDbDir, `${o.modelo}.3dtiles`);
if (!existsSync(origem)) {
  console.error(`ERRO: ${origem} nao existe.`);
  process.exit(2);
}
if (typeof globalThis.gc !== 'function') {
  console.error('ERRO: rode com `node --expose-gc bench/ordem.js`.');
  console.error('Sem o coletor sob controle a variacao entre rodadas passou de 140% no bench/banco.js.');
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

/**
 * Os tiles na ordem em que o Cesium os descobre: largura primeiro, a partir da
 * raiz, entrando em cada tileset externo no ponto em que ele e referenciado.
 */
function ordemDeTravessia(db) {
  const docs = new Map();
  for (const r of db.prepare("SELECT key, content FROM media WHERE key LIKE '%.json'").iterate()) {
    docs.set(r.key, JSON.parse(r.content.toString('utf-8')));
  }
  const raiz = docs.get('tileset.json');
  if (!raiz) throw new Error('o modelo nao tem tileset.json');

  const saida = [];
  const vistos = new Set();
  let fila = [{ tile: raiz.root, base: '' }];

  while (fila.length) {
    const proxima = [];
    for (const { tile, base } of fila) {
      if (!tile || typeof tile !== 'object') continue;
      const conteudos = [];
      if (tile.content) conteudos.push(tile.content);
      if (Array.isArray(tile.contents)) conteudos.push(...tile.contents);
      for (const c of conteudos) {
        const uri = String(c && c.uri ? c.uri : '').split('?')[0];
        if (!uri) continue;
        const chave = resolveChave(base, uri);
        if (vistos.has(chave)) continue;
        vistos.add(chave);
        saida.push(chave);
        if (uri.endsWith('.json')) {
          const externo = docs.get(chave);
          if (externo && externo.root) {
            const corte = chave.lastIndexOf('/');
            proxima.push({ tile: externo.root, base: corte < 0 ? '' : chave.slice(0, corte) });
          }
        }
      }
      if (Array.isArray(tile.children)) {
        for (const f of tile.children) proxima.push({ tile: f, base });
      }
    }
    fila = proxima;
  }
  return saida;
}

/** Copia o modelo reinserindo as linhas na ordem dada. */
function copiaNaOrdem(caminho, ordem, todas) {
  if (existsSync(caminho)) unlinkSync(caminho);
  const db = new Database(caminho);
  db.pragma('page_size = 4096');
  db.pragma('journal_mode = MEMORY');
  db.pragma('synchronous = OFF');
  db.exec('CREATE TABLE media (key TEXT PRIMARY KEY, content BLOB NOT NULL)');
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  const inserir = db.prepare('INSERT INTO media (key, content) VALUES (?, ?)');
  const lote = db.transaction((linhas) => { for (const l of linhas) inserir.run(l.key, l.content); });

  const vistas = new Set();
  let buffer = [];
  const despeja = () => { if (buffer.length) { lote(buffer); buffer = []; } };
  for (const k of ordem) {
    const linha = todas.get(k);
    if (!linha || vistas.has(k)) continue;
    vistas.add(k);
    buffer.push({ key: k, content: linha });
    if (buffer.length >= 256) despeja();
  }
  // O que a travessia nao alcancou entra no fim, para as duas copias terem o
  // MESMO conteudo. Copia com conteudo diferente nao e comparacao.
  for (const [k, v] of todas) {
    if (vistas.has(k)) continue;
    buffer.push({ key: k, content: v });
    if (buffer.length >= 256) despeja();
  }
  despeja();
  db.close();
  return statSync(caminho).size;
}

const dbOrigem = new Database(origem, { readonly: true });
const ordem = ordemDeTravessia(dbOrigem);
const todas = new Map();
for (const r of dbOrigem.prepare('SELECT key, content FROM media').iterate()) todas.set(r.key, r.content);
dbOrigem.close();

const bytesOrigem = statSync(origem).size;
console.log(`modelo ${o.modelo}: ${todas.size.toLocaleString('pt-BR')} entradas, `
  + `${(bytesOrigem / 2 ** 20).toFixed(1)} MiB`);
console.log(`travessia alcanca ${ordem.length.toLocaleString('pt-BR')} chaves`);
if (bytesOrigem < totalmem() * 0.5) {
  console.log('ATENCAO: o modelo cabe folgado na memoria do sistema. Com o cache de');
  console.log('pagina quente as duas ordens empatam por construcao, e a medida abaixo');
  console.log('mede o cache, nao o disco.');
}

const dirTmp = config.modelsDbDir;
const alvoAtual = join(dirTmp, '_ordem_atual.3dtiles');
const alvoTrav = join(dirTmp, '_ordem_travessia.3dtiles');

// A copia "atual" reinsere na ORDEM DE ROWID DE HOJE, e nao copia o arquivo.
// Copiar o arquivo carregaria tambem a fragmentacao e o freelist dele, e ai a
// comparacao mediria duas coisas ao mesmo tempo.
const ordemAtual = [...todas.keys()];
const bytesA = copiaNaOrdem(alvoAtual, ordemAtual, todas);
const bytesT = copiaNaOrdem(alvoTrav, ordem, todas);
console.log(`copias: atual ${(bytesA / 2 ** 20).toFixed(1)} MiB, travessia ${(bytesT / 2 ** 20).toFixed(1)} MiB`);

/** Abre com os pragmas de leitura do servico. */
function abre(caminho) {
  const db = new Database(caminho, { readonly: true });
  db.pragma('query_only = ON');
  db.pragma(`cache_size = ${config.modelCacheSizeKb}`);
  db.pragma(`mmap_size = ${config.modelMmapBytes}`);
  return db;
}

const leitura = ordem.filter((k) => k.endsWith('.glb')).slice(0, o.chaves);
console.log(`lendo ${leitura.length.toLocaleString('pt-BR')} tiles por rodada, `
  + `${o.rodadas} rodadas intercaladas\n`);

const bancos = {
  atual: abre(alvoAtual),
  travessia: abre(alvoTrav),
};
const consultas = {
  atual: bancos.atual.prepare('SELECT content FROM media WHERE key = ?'),
  travessia: bancos.travessia.prepare('SELECT content FROM media WHERE key = ?'),
};
const tempos = { atual: [], travessia: [] };

for (let r = 0; r < o.rodadas; r++) {
  // A ORDEM ALTERNA A CADA RODADA. Sem isto uma das duas sempre paga o
  // aquecimento, e ja inverteu um resultado no bench/banco.js.
  const nomes = r % 2 === 0 ? ['atual', 'travessia'] : ['travessia', 'atual'];
  for (const nome of nomes) {
    globalThis.gc();
    const t0 = process.hrtime.bigint();
    let bytes = 0;
    for (const k of leitura) {
      const linha = consultas[nome].get(k);
      if (linha) bytes += linha.content.length;
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    tempos[nome].push(ms);
    if (r === 0) console.log(`  (rodada 1, ${nome}: ${(bytes / 2 ** 20).toFixed(1)} MiB lidos)`);
  }
}

console.log();
console.log(`${'ordem'.padEnd(12)} ${'melhor ms'.padStart(10)} ${'mediana'.padStart(10)} ${'tiles/s'.padStart(12)}`);
const resultado = {};
for (const nome of ['atual', 'travessia']) {
  const v = tempos[nome].slice().sort((a, b) => a - b);
  const melhor = v[0];
  resultado[nome] = melhor;
  console.log(`${nome.padEnd(12)} ${melhor.toFixed(1).padStart(10)} `
    + `${v[Math.floor(v.length / 2)].toFixed(1).padStart(10)} `
    + `${Math.round((leitura.length / melhor) * 1000).toLocaleString('pt-BR').padStart(12)}`);
}
const ganho = (resultado.atual - resultado.travessia) / resultado.atual;
console.log(`\ntravessia contra atual: ${ganho >= 0 ? '+' : ''}${(ganho * 100).toFixed(1)}%`);
if (Math.abs(ganho) < 0.05) console.log('Abaixo de 5% nao passa do ruido desta bancada: EMPATE.');

for (const db of Object.values(bancos)) db.close();
if (!o.manter) {
  for (const f of [alvoAtual, alvoTrav]) { if (existsSync(f)) unlinkSync(f); }
  console.log('copias apagadas (use --manter para conservar)');
}
