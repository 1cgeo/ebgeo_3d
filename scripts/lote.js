#!/usr/bin/env node

/**
 * @module scripts/lote
 * @description Converte o acervo inteiro, UM MODELO POR VEZ, e guarda o
 * resultado no HD externo.
 *
 * O METODO E DO CHEFE, e cada passo dele responde a uma restricao real:
 *
 *   1. le a origem do HD externo
 *   2. converte com o disco de trabalho no PC
 *   3. MOVE o `.3dtiles` pronto para o HD
 *   4. apaga o que ficou no PC, e so entao passa ao proximo
 *
 * Ler e escrever direto no HD nao serve: sao horas de I/O continuo, e o HD
 * desconecta. Copiar tudo para o PC antes nao serve: o acervo tem 95 GiB e o
 * disco do PC tem menos que isso livre. Um por vez cabe, e cada modelo que
 * termina ja esta salvo.
 *
 * O ESTADO VIVE NUM ARQUIVO, e nao na memoria. Sao ~9 horas de conversao: a
 * corrida vai ser interrompida, e o que ela precisa e saber onde parou. Cada
 * modelo terminado e gravado na hora.
 *
 * O QUE ELE NAO FAZ: nao converte em paralelo (a conversao ja usa todos os
 * nucleos), nao decide o que fica publicado, e nao apaga nada da ORIGEM.
 *
 * Uso:
 *   node scripts/lote.js --destino D:/modelos_3d_convertidos --dry-run
 *   node scripts/lote.js --destino D:/modelos_3d_convertidos
 *   node scripts/lote.js --destino ... --so 5        # os 5 menores que faltam
 *   node scripts/lote.js --destino ... --id 3rcc     # um so
 */

import {
  existsSync, mkdirSync, readdirSync, statSync, copyFileSync,
  rmSync, readFileSync, writeFileSync, unlinkSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import config from '../src/config.js';

const execFileAsync = promisify(execFile);
const repo = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function args() {
  const a = process.argv.slice(2);
  const v = (n, p) => { const i = a.indexOf(n); return i >= 0 && a[i + 1] ? a[i + 1] : p; };
  return {
    origem: v('--origem', process.env.EBGEO3D_SOURCE_DIR || ''),
    destino: v('--destino', ''),
    estado: v('--estado', join(repo, 'data', 'lote.json')),
    so: v('--so') ? parseInt(v('--so'), 10) : null,
    id: v('--id', null),
    dryRun: a.includes('--dry-run'),
    refazer: a.includes('--refazer'),
  };
}

const o = args();

/** Transforma o nome da pasta num id de catalogo. */
function paraId(pasta) {
  return pasta.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * O HD respondeu?
 *
 * O `readdirSync` de um caminho em disco removido devolve UNKNOWN no Windows, e
 * nao ENOENT. Uma corrida de horas tem de reconhecer isso e PARAR, e nao tratar
 * como pasta vazia e seguir dizendo que nao havia nada a fazer.
 */
function respondeDisco(caminho) {
  try { tentando(() => readdirSync(caminho), 2); return true; } catch { return false; }
}

/**
 * Tamanho de uma arvore, em bytes, TOLERANTE a erro de leitura.
 *
 * DUAS RAZOES PARA A TOLERANCIA, e as duas apareceram na primeira corrida.
 * O HD externo devolve EIO no meio de uma varredura longa, e devolve ENOENT
 * para um arquivo que a listagem ACABOU de citar. Estourar ali derruba o
 * roteiro antes de converter qualquer coisa, por causa de uma conta que so
 * serve para ordenar a fila.
 *
 * O que nao pode ser lido nao entra na conta, e o total sai subestimado. Isso e
 * aceitavel: ele ordena a fila, e nao decide nada.
 */
function tamanho(raiz) {
  let bytes = 0;
  let erros = 0;
  (function anda(dir) {
    let entradas;
    try { entradas = readdirSync(dir, { withFileTypes: true }); } catch { erros++; return; }
    for (const e of entradas) {
      const p = join(dir, e.name);
      try {
        if (e.isDirectory()) anda(p); else bytes += statSync(p).size;
      } catch { erros++; }
    }
  })(raiz);
  return { bytes, erros };
}

/**
 * Copia uma arvore inteira, TENTANDO DE NOVO em cada passo.
 *
 * O HD externo devolve `UNKNOWN` no meio de leitura longa e volta a responder
 * logo depois. Aconteceu duas vezes na corrida do acervo: uma na copia de saida
 * (2,7 GiB) e outra no `scandir` da origem. Sem retentativa, um solucao de um
 * segundo derruba a copia de um modelo de 10 GiB inteira.
 *
 * A espera cresce, e tres tentativas cobrem o solucao. Se o disco caiu de vez,
 * a terceira falha tambem, e a guarda do proximo modelo para a corrida com a
 * mensagem certa.
 */
function tentando(o_que, quantas = 3) {
  let ultimo = null;
  for (let i = 1; i <= quantas; i++) {
    try { return o_que(); } catch (err) {
      ultimo = err;
      if (i < quantas) {
        const ate = Date.now() + i * 3000;
        // Espera OCUPADA porque esta funcao e sincrona, e torna-la assincrona
        // espalharia `await` por toda a copia recursiva. Sao no maximo 9
        // segundos numa corrida de horas.
        while (Date.now() < ate) { /* espera */ }
      }
    }
  }
  throw ultimo;
}

/** Copia uma arvore inteira. */
function copiaArvore(de, para) {
  mkdirSync(para, { recursive: true });
  for (const e of tentando(() => readdirSync(de, { withFileTypes: true }))) {
    const origem = join(de, e.name);
    const alvo = join(para, e.name);
    if (e.isDirectory()) copiaArvore(origem, alvo);
    else tentando(() => copyFileSync(origem, alvo));
  }
}

function leEstado() {
  try {
    const e = JSON.parse(readFileSync(o.estado, 'utf-8'));
    return { feitos: {}, falhas: {}, tamanhos: {}, ...e };
  } catch {
    return { feitos: {}, falhas: {}, tamanhos: {} };
  }
}

function gravaEstado(e) {
  mkdirSync(join(repo, 'data'), { recursive: true });
  writeFileSync(o.estado, JSON.stringify(e, null, 2), 'utf-8');
}

// ---------------------------------------------------------------- entrada

if (!o.origem || !o.destino) {
  console.error('Uso: node scripts/lote.js --destino <pasta no HD> [--origem <pasta>]');
  console.error('     --origem cai em EBGEO3D_SOURCE_DIR quando omitido.');
  process.exit(2);
}
if (!respondeDisco(o.origem)) {
  console.error(`ERRO: a origem nao responde: ${o.origem}`);
  console.error('O HD externo esta conectado?');
  process.exit(2);
}

const estado = leEstado();

// Candidatos: toda pasta da origem que tenha tileset.json na raiz, ou um .glb
// solto. As outras nao sao modelo, e dizer isso agora evita descobrir no meio.
const candidatos = [];
let novosTamanhos = false;
for (const e of readdirSync(o.origem, { withFileTypes: true })) {
  if (!e.isDirectory()) continue;
  const pasta = join(o.origem, e.name);
  let arquivos;
  try { arquivos = readdirSync(pasta); } catch { continue; }
  const temTileset = arquivos.includes('tileset.json');
  const glbs = arquivos.filter((f) => f.toLowerCase().endsWith('.glb'));
  if (!temTileset && glbs.length !== 1) continue;
  const id = paraId(e.name);
  // O TAMANHO SE MEDE UMA VEZ SO, e fica no estado.
  //
  // Varrer o acervo inteiro custa 2,2 MILHOES de `stat` no HD externo, e foi
  // exatamente esse I/O continuo que fez o disco devolver EIO na primeira
  // corrida. Ele serve so para ordenar a fila: pagar isso a cada execucao seria
  // castigar o HD por uma conta que nao decide nada.
  let bytes = estado.tamanhos?.[id];
  if (bytes == null) {
    const t = tamanho(pasta);
    bytes = t.bytes;
    if (t.erros) console.log(`  (${e.name}: ${t.erros} entradas ilegiveis na varredura)`);
    estado.tamanhos = estado.tamanhos || {};
    estado.tamanhos[id] = bytes;
    novosTamanhos = true;
  }
  candidatos.push({
    pasta: e.name,
    caminho: pasta,
    id,
    tipo: temTileset ? 'arvore' : 'glb',
    bytes,
  });
}
if (novosTamanhos) gravaEstado(estado);

let fila = candidatos
  .filter((c) => (o.id ? c.id === o.id || c.pasta === o.id : true))
  .filter((c) => o.refazer || !estado.feitos[c.id])
  .sort((a, b) => a.bytes - b.bytes);
if (o.so) fila = fila.slice(0, o.so);

const totalBytes = fila.reduce((s, c) => s + c.bytes, 0);
const feitos = Object.keys(estado.feitos).length;
console.log(`origem  ${o.origem}`);
console.log(`destino ${o.destino}`);
console.log(`${candidatos.length} modelos na origem, ${feitos} ja feitos, ${fila.length} na fila`);
console.log(`fila: ${(totalBytes / 2 ** 30).toFixed(1)} GiB de entrada\n`);

if (o.dryRun) {
  console.log(`${'modelo'.padEnd(34)}${'tipo'.padEnd(8)}${'GiB'.padStart(8)}`);
  for (const c of fila) console.log(`${c.pasta.padEnd(34)}${c.tipo.padEnd(8)}${(c.bytes / 2 ** 30).toFixed(2).padStart(8)}`);
  console.log('\n--dry-run: nada foi convertido.');
  process.exit(0);
}

mkdirSync(o.destino, { recursive: true });

// ---------------------------------------------------------------- corrida

const t0 = Date.now();
let ok = 0;
let falhou = 0;

for (const [i, c] of fila.entries()) {
  const rotulo = `[${i + 1}/${fila.length}] ${c.pasta}`;
  console.log(`\n${'='.repeat(70)}\n${rotulo}  (${(c.bytes / 2 ** 30).toFixed(2)} GiB, ${c.tipo})`);

  // O HD SE CONFERE A CADA MODELO, e nao so no comeco. Numa corrida de horas
  // ele cai no meio, e seguir depois disso produziria falha atras de falha com
  // a causa escondida na primeira.
  if (!respondeDisco(o.origem) || !respondeDisco(o.destino)) {
    console.error('\nPARADO: o HD externo nao responde mais.');
    console.error('Reconecte e rode de novo: o que ja terminou nao se refaz.');
    break;
  }

  const trabalho = join(config.dataDir, 'origem-lote', c.pasta);
  const publicado = join(config.modelsDbDir, `${c.id}.3dtiles`);
  const alvo = join(o.destino, `${c.id}.3dtiles`);
  const inicio = Date.now();

  try {
    // 1. traz a origem para o disco do PC
    if (existsSync(trabalho)) rmSync(trabalho, { recursive: true, force: true });
    process.stdout.write('  copiando do HD... ');
    copiaArvore(c.caminho, trabalho);
    console.log(`${(tamanho(trabalho).bytes / 2 ** 20).toFixed(0)} MiB`);

    // 2. converte
    const roteiro = c.tipo === 'glb' ? 'importar-glb.js' : 'importar.js';
    const argv = [join(repo, 'scripts', roteiro), '--origem', trabalho, '--id', c.id, '--forcar'];
    // O modelo GLB precisa de onde plantar, e o lote nao tem como saber: ele
    // fica para a mao, com o `importar-glb.js` direto.
    if (c.tipo === 'glb') {
      console.log('  PULADO: modelo GLB precisa de --lon e --lat, que so voce sabe.');
      estado.falhas[c.id] = 'glb sem posicao: importe a mao';
      gravaEstado(estado);
      rmSync(trabalho, { recursive: true, force: true });
      continue;
    }
    const { stdout, stderr } = await execFileAsync(process.execPath, argv, {
      cwd: repo,
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    });
    const saida = stdout + stderr;
    const linhaRazao = saida.split('\n').find((l) => l.includes('razao')) || '';
    console.log(`  ${linhaRazao.trim()}`);

    // 3. MOVE o pronto para o HD. `rename` entre volumes nao funciona, entao
    //    copia e apaga, nesta ordem: um corte de energia no meio deixa o
    //    original intacto, e nao um arquivo pela metade sem par.
    if (!existsSync(publicado)) throw new Error('o .3dtiles nao apareceu em data/models');
    const bytesPublicado = statSync(publicado).size;
    process.stdout.write('  levando para o HD... ');

    // A COPIA TENTA DE NOVO, e a razao apareceu na corrida: o HD externo
    // devolveu `UNKNOWN` num `copyfile` de 2,7 GiB e voltou a responder logo
    // depois. Sem retentativa, um solucao de um segundo custa a RECONVERSAO
    // inteira do modelo, que ali eram 20 minutos ja gastos.
    //
    // Tres tentativas, com espera crescente. Se o disco caiu de vez, a guarda
    // do proximo modelo pega e a corrida para com a mensagem certa.
    let bytesAlvo = 0;
    let ultimoErro = null;
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      try {
        copyFileSync(publicado, alvo);
        bytesAlvo = statSync(alvo).size;
        if (bytesAlvo !== bytesPublicado) {
          throw new Error(`copia truncada: ${bytesAlvo} de ${bytesPublicado} bytes`);
        }
        ultimoErro = null;
        break;
      } catch (err) {
        ultimoErro = err;
        // A copia parcial SAI antes da proxima tentativa: um arquivo pela
        // metade no destino e pior que nenhum, porque parece pronto.
        try { if (existsSync(alvo)) unlinkSync(alvo); } catch { /* ja saiu */ }
        if (tentativa < 3) {
          process.stdout.write(`(${err.code || 'erro'}, tentativa ${tentativa + 1}) `);
          await new Promise((r) => { setTimeout(r, tentativa * 5000); });
        }
      }
    }
    if (ultimoErro) throw ultimoErro;
    console.log(`${(bytesAlvo / 2 ** 20).toFixed(0)} MiB conferidos`);

    // 4. limpa o PC
    unlinkSync(publicado);
    rmSync(trabalho, { recursive: true, force: true });

    const seg = (Date.now() - inicio) / 1000;
    estado.feitos[c.id] = {
      pasta: c.pasta,
      bytesEntrada: c.bytes,
      bytesSaida: bytesAlvo,
      segundos: Math.round(seg),
      em: new Date().toISOString(),
    };
    delete estado.falhas[c.id];
    gravaEstado(estado);
    ok++;
    console.log(`  OK em ${(seg / 60).toFixed(1)} min`);
  } catch (err) {
    falhou++;
    const motivo = (err.stdout || '') + (err.stderr || '') || err.message;
    console.error(`  FALHOU: ${motivo.split('\n').slice(-6).join('\n  ')}`);
    estado.falhas[c.id] = motivo.slice(-2000);
    gravaEstado(estado);
    // A limpeza acontece MESMO na falha: sem ela o disco do PC enche no
    // terceiro modelo grande, e a corrida morre por espaco em vez de pelo erro.
    try { rmSync(trabalho, { recursive: true, force: true }); } catch { /* ja nao existe */ }
    try { if (existsSync(publicado)) unlinkSync(publicado); } catch { /* em uso */ }
  }

  const decorrido = (Date.now() - t0) / 1000;
  const restantes = fila.length - i - 1;
  if (restantes > 0 && ok > 0) {
    console.log(`  decorrido ${(decorrido / 60).toFixed(0)} min, restam ${restantes}`
      + `  (~${((decorrido / (i + 1)) * restantes / 60).toFixed(0)} min)`);
  }
}

console.log(`\n${'='.repeat(70)}`);
console.log(`${ok} convertidos, ${falhou} falharam, em ${((Date.now() - t0) / 3600000).toFixed(1)} h`);
if (falhou) {
  console.log('\nFALHAS (o estado guarda o motivo de cada uma):');
  for (const [id, m] of Object.entries(estado.falhas)) {
    console.log(`  ${id}: ${String(m).split('\n').pop().slice(0, 110)}`);
  }
}
console.log(`estado em ${basename(o.estado)}`);
