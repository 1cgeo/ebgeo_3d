#!/usr/bin/env node

/**
 * @module bench/banco
 * @description Bancada da camada SQLite, sem HTTP no meio.
 *
 * POR QUE SEPARAR DO bench/http.js. Aquele mede o que o cliente sente, e nele o
 * custo do banco fica misturado com o do Fastify, do keep-alive e do loop de
 * eventos. Este isola a leitura do BLOB, que e o unico lugar onde mexer em
 * pragma muda alguma coisa. Sem a separacao, uma melhora de 20% no banco some
 * dentro do ruido do HTTP e ninguem sabe se o pragma ajudou.
 *
 * TRES CUIDADOS QUE ESTA BANCADA APRENDEU A TER, cada um depois de uma medida
 * que mentiu:
 *
 * 1. RODADAS INTERCALADAS. Medir uma configuracao inteira e depois a outra mede
 *    o cache de pagina do sistema esquentando. Ja inverteu um resultado nosso:
 *    `page_size` 16K apareceu 37% na frente do 4K numa ordem e 16% atras noutra.
 *
 * 2. COLETOR DE LIXO CONTROLADO. Cada leitura aloca um Buffer do tamanho do tile
 *    (40 KiB em media), entao uma rodada de 4.000 chaves produz cerca de 160 MB
 *    de lixo. Sem `--expose-gc` a variacao entre rodadas passou de 140%, e
 *    chegou a mostrar `cache 2 MB` na frente de `cache 32 MB`, que e impossivel.
 *
 * 3. A MELHOR RODADA, e nao a media. A melhor e a que menos pagou interferencia
 *    de fora. A media soma o ruido de todo mundo, e a mediana ainda carrega
 *    metade dele.
 *
 * Uso:
 *   node --expose-gc bench/banco.js --modelo ponte-quatis
 *   node --expose-gc bench/banco.js --modelo ponte-quatis --chaves 8000 --rodadas 21
 */

import { statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import config from '../src/config.js';

function args() {
  const a = process.argv.slice(2);
  const v = (n, p) => { const i = a.indexOf(n); return i >= 0 && a[i + 1] ? a[i + 1] : p; };
  return {
    modelo: v('--modelo', 'ponte-quatis'),
    chaves: parseInt(v('--chaves', '4000'), 10),
    rodadas: parseInt(v('--rodadas', '15'), 10),
  };
}

const o = args();
const caminho = join(config.modelsDbDir, `${o.modelo}.3dtiles`);
try {
  statSync(caminho);
} catch {
  console.error(`ERRO: ${caminho} nao existe.`);
  const disponiveis = readdirSync(config.modelsDbDir).filter((f) => f.endsWith('.3dtiles'));
  console.error(`modelos disponiveis: ${disponiveis.join(', ') || '(nenhum)'}`);
  process.exit(2);
}

/** Amostra determinista, para todas as configuracoes lerem exatamente o mesmo. */
function amostra(nomes, k, semente = 987) {
  const saida = [];
  let s = semente;
  for (let i = 0; i < k; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    saida.push(nomes[s % nomes.length]);
  }
  return saida;
}

const mediana = (v) => [...v].sort((a, b) => a - b)[v.length >> 1];
const mib = (b) => b / 1048576;

// ---------------------------------------------------------------- configuracoes

/**
 * Cada configuracao e uma hipotese testavel. `padrao` e o que o serviço usa
 * hoje; as outras respondem "e se".
 */
const CONFIGS = [
  { nome: 'padrao (o servico)', cache: config.modelCacheSizeKb, mmap: config.modelMmapBytes, queryOnly: true },
  { nome: 'sem mmap', cache: config.modelCacheSizeKb, mmap: 0, queryOnly: true },
  { nome: 'mmap 256 MB', cache: config.modelCacheSizeKb, mmap: 256 * 1024 * 1024, queryOnly: true },
  { nome: 'mmap 1 GB', cache: config.modelCacheSizeKb, mmap: 1024 * 1024 * 1024, queryOnly: true },
  { nome: 'cache 2 MB', cache: -2000, mmap: config.modelMmapBytes, queryOnly: true },
  { nome: 'cache 32 MB', cache: -32000, mmap: config.modelMmapBytes, queryOnly: true },
  { nome: 'mmap 256 + cache 2 MB', cache: -2000, mmap: 256 * 1024 * 1024, queryOnly: true },
  { nome: 'sem query_only', cache: config.modelCacheSizeKb, mmap: config.modelMmapBytes, queryOnly: false },
];

function abre(c) {
  const db = new Database(caminho, { readonly: true });
  if (c.queryOnly) db.pragma('query_only = true');
  db.pragma(`cache_size = ${c.cache}`);
  db.pragma('busy_timeout = 5000');
  db.pragma(`mmap_size = ${c.mmap}`);
  return db;
}

// ---------------------------------------------------------------- execucao

const bytes = statSync(caminho).size;
const sonda = new Database(caminho, { readonly: true });
const pageSize = sonda.pragma('page_size', { simple: true });
const nomes = sonda.prepare("SELECT key FROM media WHERE key NOT LIKE '%.json'").all().map((r) => r.key);
const totalEntradas = sonda.prepare('SELECT COUNT(*) AS n FROM media').get().n;
sonda.close();

console.log(`arquivo    ${o.modelo}.3dtiles  ${mib(bytes).toFixed(1)} MiB  page_size=${pageSize}`);
console.log(`conteudo   ${totalEntradas.toLocaleString('pt-BR')} entradas, ${nomes.length.toLocaleString('pt-BR')} tiles`);
console.log(`carga      ${o.chaves.toLocaleString('pt-BR')} leituras x ${o.rodadas} rodadas intercaladas`);

const coleta = typeof global.gc === 'function' ? global.gc : null;
if (!coleta) {
  console.log('\nAVISO: sem --expose-gc a variacao passa de 100% e a comparacao nao decide nada.');
  console.log('       rode: node --expose-gc bench/banco.js ...');
}
console.log('');

const alvo = amostra(nomes, o.chaves);
const rssInicial = process.memoryUsage().rss;

const abertos = CONFIGS.map((c) => {
  const db = abre(c);
  return { ...c, db, stmt: db.prepare('SELECT content FROM media WHERE key = ?'), tempos: [] };
});

// Aquecimento de TODOS antes de medir qualquer um: a primeira leitura de cada
// pagina paga o disco, e sem isto a primeira configuracao da lista paga por todas.
for (const c of abertos) {
  for (let i = 0; i < 500; i++) c.stmt.get(alvo[i % alvo.length]);
}
const rssApos = process.memoryUsage().rss;

for (let r = 0; r < o.rodadas; r++) {
  for (const c of abertos) {
    if (coleta) coleta();
    const t0 = process.hrtime.bigint();
    let n = 0;
    for (const k of alvo) n += c.stmt.get(k).content.length;
    const dt = Number(process.hrtime.bigint() - t0) / 1e9;
    c.tempos.push({ dt, bytes: n });
  }
}

// ---------------------------------------------------------------- resultado

console.log(`${'configuracao'.padEnd(22)} ${'melhor/s'.padStart(10)} ${'mediana/s'.padStart(10)} ${'MiB/s'.padStart(8)} ${'us/leit'.padStart(8)} ${'dispersao'.padStart(10)}`);
const linhas = [];
for (const c of abertos) {
  const taxas = c.tempos.map((t) => alvo.length / t.dt);
  const melhor = Math.max(...taxas);
  const med = mediana(taxas);
  const mbs = mib(c.tempos[0].bytes) * melhor / alvo.length;
  const dispersao = ((melhor / Math.min(...taxas)) - 1) * 100;
  linhas.push({ nome: c.nome, melhor, med, dispersao });
  console.log(
    `${c.nome.padEnd(22)} ${melhor.toFixed(0).padStart(10)} ${med.toFixed(0).padStart(10)} `
    + `${mbs.toFixed(0).padStart(8)} ${(1e6 / melhor).toFixed(1).padStart(8)} ${`${dispersao.toFixed(0)}%`.padStart(10)}`,
  );
  c.db.close();
}

const base = linhas[0];
console.log('\ncontra o padrao do servico, pela MELHOR rodada de cada:');
let algumDecide = false;
for (const l of linhas.slice(1)) {
  const delta = ((l.melhor / base.melhor) - 1) * 100;
  // A regua e a metade da MENOR dispersao entre as duas medidas comparadas, com
  // piso de 5%. Diferenca abaixo dela pode ser so a rodada que calhou de correr
  // sozinha, e nao sustenta trocar um pragma.
  const regua = Math.max(5, Math.min(base.dispersao, l.dispersao) / 2);
  const decide = Math.abs(delta) > regua;
  if (decide) algumDecide = true;
  console.log(
    `  ${l.nome.padEnd(22)} ${(delta >= 0 ? '+' : '') + delta.toFixed(1)}%`.padEnd(38)
    + `regua ${regua.toFixed(0)}%`
    + (decide ? '   <-- FORA DO RUIDO' : '   (nao decide)'),
  );
}

console.log(`\nRSS do processo: ${mib(rssInicial).toFixed(0)} MiB antes, ${mib(rssApos).toFixed(0)} MiB depois de abrir `
  + `${CONFIGS.length} conexoes e aquecer.`);
console.log('ATENCAO: este numero soma TODAS as configuracoes abertas ao mesmo tempo, que e');
console.log('exatamente o que o serviço NAO faz. Para a memoria de verdade, use bench/memoria.js.');

if (!algumDecide) {
  console.log('\nNenhuma configuracao se destacou fora do ruido: os pragmas de hoje estao bons,');
  console.log('e o gargalo nao esta aqui. Meça o HTTP com bench/http.js.');
}
