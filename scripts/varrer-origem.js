/**
 * @module scripts/varrer-origem
 * @description Varre a origem inteira procurando dado quebrado, ANTES de converter.
 *
 * POR QUE EXISTE. O `estrela-merge` tinha 329 arquivos de 0 byte confinados num
 * ramo, e a `passadeira` e o `TanqueDeFerro` perderam o `tileset.json` de um
 * ramo cada. Os tres so apareceram quando a conversao bateu neles, um por um, ao
 * longo de dias. Perda de dado em disco externo nao avisa, e descobri-la tarde
 * custa a corrida inteira.
 *
 * O QUE ELA PROCURA, em ordem crescente de custo:
 *   1. arquivo de 0 byte              (um `stat`)
 *   2. arquivo que nao le             (o `stat` lanca)
 *   3. `tileset.json` invalido        (le e faz parse)
 *   4. referencia que nao existe      (resolve as uris contra o disco)
 *
 * ELA NAO CONSERTA NADA, e nao escreve na origem. So mede e relata.
 *
 * TOLERANTE POR PROJETO. O HD externo devolve EIO e UNKNOWN no meio de leitura
 * longa, e uma varredura que morre no primeiro solucao nunca termina em 2,2
 * milhoes de arquivos. Cada erro entra na conta e a varredura segue.
 *
 * RETOMAVEL. O estado por modelo vai para o disco a cada modelo terminado, e
 * rodar de novo pula quem ja passou. Use `--refazer` para ignorar o estado.
 *
 * Uso:
 *   node scripts/varrer-origem.js --piloto 3           # mede a taxa e sai
 *   node scripts/varrer-origem.js                      # a origem inteira
 *   node scripts/varrer-origem.js --json <arquivo>     # relatorio completo
 */

import { readdirSync, statSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tentando } from './lib/copia.js';
import { fileURLToPath } from 'node:url';

const repo = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function args() {
  const a = process.argv.slice(2);
  const v = (n, p) => { const i = a.indexOf(n); return i >= 0 && a[i + 1] ? a[i + 1] : p; };
  return {
    origem: v('--origem', process.env.EBGEO3D_SOURCE_DIR || ''),
    estado: v('--estado', join(repo, 'data', 'varredura.json')),
    json: v('--json', null),
    piloto: v('--piloto') ? parseInt(v('--piloto'), 10) : null,
    refazer: a.includes('--refazer'),
  };
}
const o = args();

if (!o.origem) {
  console.error('ERRO: sem origem. Passe --origem, ou defina EBGEO3D_SOURCE_DIR.');
  process.exit(2);
}

/** Resolve uma uri relativa AO PROPRIO tileset, e nao a raiz do modelo. */
function normaliza(p) {
  const partes = [];
  for (const t of p.split('/')) {
    if (!t || t === '.') continue;
    if (t === '..') partes.pop(); else partes.push(t);
  }
  return partes.join('/');
}

/** Colhe as uris de conteudo de um tileset, em qualquer profundidade. */
function urisDe(json) {
  const fora = [];
  (function anda(n) {
    if (!n || typeof n !== 'object') return;
    const u = n.content?.uri || n.content?.url;
    if (u) fora.push(u);
    for (const c of n.children || []) anda(c);
  })(json.root || {});
  return fora;
}

/** Varre um modelo. Nunca lanca: o que nao le vira numero. */
function varreModelo(raiz) {
  const r = {
    arquivos: 0, bytes: 0, vazios: [], ilegiveis: [],
    tilesets: 0, jsonInvalido: [], refsQuebradas: [], pastasIlegiveis: 0,
  };
  const jsons = [];

  (function anda(dir) {
    let entradas;
    // RETENTATIVA, porque o disco engasga e volta. Medido em 2026-08-23: a
    // pasta `1bdacmec` foi recusada numa passagem e listou 4 itens no segundo
    // seguinte, por outro programa.
    try { entradas = tentando(() => readdirSync(dir, { withFileTypes: true }), 3); } catch {
      r.pastasIlegiveis += 1;
      return;
    }
    for (const e of entradas) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { anda(p); continue; }
      r.arquivos += 1;
      let s;
      try { s = statSync(p).size; } catch {
        r.ilegiveis.push(p.slice(raiz.length + 1));
        continue;
      }
      r.bytes += s;
      if (s === 0) r.vazios.push(p.slice(raiz.length + 1));
      else if (e.name.toLowerCase().endsWith('.json')) jsons.push(p);
    }
  })(raiz);

  // Os JSON custam leitura e parse, entao vem depois do `stat` de todo mundo.
  for (const p of jsons) {
    if (basename(p).toLowerCase() !== 'tileset.json') continue;
    r.tilesets += 1;
    let j;
    try { j = JSON.parse(readFileSync(p, 'utf-8')); } catch (err) {
      r.jsonInvalido.push(`${p.slice(raiz.length + 1)}: ${err.message.slice(0, 60)}`);
      continue;
    }
    const base = dirname(p);
    for (const u of urisDe(j)) {
      const alvo = join(base, normaliza(u));
      if (!existsSync(alvo)) r.refsQuebradas.push(`${p.slice(raiz.length + 1)} -> ${u}`);
    }
  }
  return r;
}

function leEstado() {
  if (o.refazer) return { modelos: {} };
  try { return { modelos: {}, ...JSON.parse(readFileSync(o.estado, 'utf-8')) }; } catch {
    return { modelos: {} };
  }
}
function gravaEstado(e) {
  mkdirSync(dirname(o.estado), { recursive: true });
  writeFileSync(o.estado, JSON.stringify(e, null, 2), 'utf-8');
}

let pastas;
try {
  pastas = readdirSync(o.origem, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name);
} catch (err) {
  console.error(`ERRO: a origem nao responde: ${err.code}`);
  process.exit(2);
}

const estado = leEstado();
const fila = pastas.filter((p) => o.refazer || !estado.modelos[p]);
const alvo = o.piloto ? fila.slice(0, o.piloto) : fila;

console.log(`${pastas.length} pastas na origem, ${Object.keys(estado.modelos).length} ja varridas`);
console.log(`varrendo ${alvo.length}${o.piloto ? ' (PILOTO)' : ''}\n`);

const t0 = Date.now();
let arquivosTotal = 0;
const naoMedidos = [];
for (const [i, nome] of alvo.entries()) {
  const t = Date.now();
  const r = varreModelo(join(o.origem, nome));
  const seg = (Date.now() - t) / 1000;
  arquivosTotal += r.arquivos;
  // PASTA QUE O DISCO RECUSOU NAO CONTA COMO VARRIDA. Gravar no estado a
  // marcaria como concluida com zero arquivos, e a proxima corrida a pularia:
  // um modelo inteiro sairia do relatorio como "sem achado". Falha de leitura e
  // ausencia de medida, nunca medida limpa.
  if (r.pastasIlegiveis === 0) {
    estado.modelos[nome] = { ...r, segundos: Number(seg.toFixed(1)) };
    gravaEstado(estado);
  } else {
    naoMedidos.push(nome);
  }

  const problemas = r.vazios.length + r.ilegiveis.length + r.jsonInvalido.length
    + r.refsQuebradas.length + r.pastasIlegiveis;
  const marca = problemas ? 'PROBLEMA' : 'ok      ';
  console.log(`[${String(i + 1).padStart(3)}/${alvo.length}] ${marca} ${nome.padEnd(30)}`
    + ` ${r.arquivos.toLocaleString('pt-BR').padStart(9)} arq`
    + ` ${(r.bytes / 2 ** 30).toFixed(2).padStart(6)} GiB`
    + ` ${seg.toFixed(0).padStart(4)}s`
    + (problemas ? `   ${problemas} achado(s)` : ''));
  if (r.vazios.length) {
    console.log(`         ${r.vazios.length} vazios, ex: ${r.vazios.slice(0, 2).join(', ')}`);
  }
  if (r.ilegiveis.length) {
    console.log(`         ${r.ilegiveis.length} ilegiveis, ex: ${r.ilegiveis.slice(0, 2).join(', ')}`);
  }
  if (r.jsonInvalido.length) {
    console.log(`         ${r.jsonInvalido.length} json invalido: ${r.jsonInvalido.slice(0, 2).join(' | ')}`);
  }
  if (r.refsQuebradas.length) {
    console.log(`         ${r.refsQuebradas.length} refs quebradas, ex: ${r.refsQuebradas.slice(0, 2).join(' | ')}`);
  }
  if (r.pastasIlegiveis) {
    console.log(`         ${r.pastasIlegiveis} pasta(s) que o disco recusou`);
  }
}

const min = (Date.now() - t0) / 60000;
const taxa = arquivosTotal / (min * 60 || 1);
console.log(`\n${'='.repeat(70)}`);
console.log(`${arquivosTotal.toLocaleString('pt-BR')} arquivos em ${min.toFixed(1)} min`
  + `  (${Math.round(taxa).toLocaleString('pt-BR')} arquivos/s)`);

if (o.piloto) {
  const restam = pastas.length - Object.keys(estado.modelos).length;
  const medio = arquivosTotal / (alvo.length || 1);
  console.log(`\nPILOTO. Restam ${restam} pastas.`);
  console.log(`Projecao: ${Math.round((restam * medio) / taxa / 60)} min para o resto,`
    + ` a ${Math.round(medio).toLocaleString('pt-BR')} arquivos por pasta.`);
  console.log('O numero e o recorte vao para a mesa antes de escalar.');
}

// O balanco sai sempre, e nao so no fim: uma varredura interrompida ja informa.
const todos = Object.entries(estado.modelos);
const comProblema = todos.filter(([, r]) => r.vazios.length || r.ilegiveis.length
  || r.jsonInvalido.length || r.refsQuebradas.length || r.pastasIlegiveis);
console.log(`\n${todos.length} modelos varridos, ${comProblema.length} com achado.`);
for (const [nome, r] of comProblema) {
  console.log(`  ${nome}: ${r.vazios.length} vazios, ${r.ilegiveis.length} ilegiveis,`
    + ` ${r.jsonInvalido.length} json invalido, ${r.refsQuebradas.length} refs quebradas`);
}

if (o.json) {
  writeFileSync(o.json, JSON.stringify(estado, null, 2), 'utf-8');
  console.log(`\nrelatorio em ${o.json}`);
}
