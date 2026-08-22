#!/usr/bin/env node

/**
 * @module scripts/importar-cena
 * @description Importa uma CENA navegavel a pe (Gaussian Splatting): a pasta
 * que a pipeline de processamento produz, copiada como esta.
 *
 * NADA AQUI VAI PARA SQLITE, e isso e a decisao central. Uma cena e um splat de
 * dezenas de MB mais um octree de colisao que o visualizador le EM FAIXA. O
 * sistema de arquivos serve isso melhor que um BLOB, e aqui nao ha os milhares
 * de objetos pequenos que o `.3dtiles` existe para resolver. Vai para o banco so
 * o METADADO, que e o que o `config.js` do ebgeo_web deixa de carregar.
 *
 * NADA E CONVERTIDO. O `.sog` e o octree sao formato de outra pipeline, e
 * reescreve-los aqui seria decidir por ela. A copia e byte a byte, e a
 * conferencia e por `sha256` de cada arquivo.
 *
 * O LAYOUT DA PASTA E CONTRATO com o `scene-config.service.js` do ebgeo_web:
 *
 *   cena.sog                  o splat
 *   voxel/voxel-meta.json     cabecalho do octree de colisao
 *   voxel/voxel.bin           corpo do octree
 *   marcadores.json           fichas curadas
 *   itens/                    fotos das fichas
 *   preview/preview.webm      video do cartao do catalogo
 *   preview/thumbnail.jpg     capa do cartao
 *
 * Uso:
 *   node scripts/importar-cena.js --origem <pasta> --id museu-1cgeo \
 *     --nome "Sala Historica General Malan" --lon -51.2 --lat -30.03 \
 *     [--pose "3.82,0.55,1.42,0,0"] [--velocidade 2.4] [--fov 60] [--dry-run]
 */

import {
  existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync, createReadStream,
} from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import config from '../src/config.js';
import { getIndexDb, closeAll } from '../src/db/connection.js';
import { upsertScene, getSceneAny } from '../src/db/queries.js';

/**
 * Arquivos que a cena PRECISA ter.
 *
 * Sem o splat nao ha o que ver; sem o octree a cena abre bonita e o visitante
 * atravessa parede, sem nada no console. Faltar em silencio e o modo de falha
 * que este portao fecha.
 */
const OBRIGATORIOS = ['cena.sog', 'voxel/voxel-meta.json', 'voxel/voxel.bin'];

/** Arquivos que a cena costuma ter, e cuja ausencia so vira aviso. */
const ESPERADOS = ['marcadores.json', 'preview/preview.webm', 'preview/thumbnail.jpg'];

function args() {
  const a = process.argv.slice(2);
  const v = (n, p) => { const i = a.indexOf(n); return i >= 0 && a[i + 1] ? a[i + 1] : p; };
  const num = (n, p) => { const x = v(n); return x == null ? p : Number(x); };
  return {
    origem: v('--origem'),
    id: v('--id'),
    nome: v('--nome'),
    descricao: v('--descricao'),
    local: v('--local'),
    dataCaptura: v('--data-captura'),
    keywords: v('--keywords'),
    lon: num('--lon', null),
    lat: num('--lat', null),
    pose: v('--pose'),
    velocidade: num('--velocidade', null),
    fov: num('--fov', null),
    forcar: a.includes('--forcar'),
    dryRun: a.includes('--dry-run'),
  };
}

/** Lista todos os arquivos da pasta, em caminho relativo com barra normal. */
function inventaria(raiz) {
  const arquivos = [];
  let bytes = 0;
  (function anda(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { anda(p); continue; }
      arquivos.push(relative(raiz, p).replace(/\\/g, '/'));
      bytes += statSync(p).size;
    }
  })(raiz);
  return { arquivos: arquivos.sort(), bytes };
}

/** sha256 de um arquivo, por fluxo: o splat passa de 20 MB. */
function sha256(caminho) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(caminho).on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

async function main() {
  const o = args();
  if (!o.origem || !o.id) {
    console.error('Uso: node scripts/importar-cena.js --origem <pasta> --id <slug>'
      + ' --nome "..." [--lon N --lat N] [--pose "x,y,z,yaw,pitch"]');
    process.exit(2);
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(o.id)) {
    console.error(`ERRO: --id "${o.id}" invalido. Use minusculas, digitos, hifen e sublinhado.`);
    process.exit(2);
  }
  if (!existsSync(o.origem) || !statSync(o.origem).isDirectory()) {
    console.error(`ERRO: --origem tem de ser uma PASTA: ${o.origem}`);
    process.exit(2);
  }

  const log = (s) => console.log(s);
  const passo = (t) => console.log(`\n--- ${t} ---`);

  getIndexDb();
  const jaExiste = getSceneAny(o.id);
  if (jaExiste && !o.forcar) {
    console.error(`ERRO: a cena "${o.id}" ja esta no catalogo (importada em ${jaExiste.imported_at}).`);
    console.error('Use --forcar para reimportar por cima.');
    closeAll();
    process.exit(3);
  }

  passo('1. inventario da origem');
  const inv = inventaria(o.origem);
  log(`  ${inv.arquivos.length.toLocaleString('pt-BR')} arquivos, ${(inv.bytes / 2 ** 20).toFixed(1)} MiB`);

  const faltando = OBRIGATORIOS.filter((f) => !inv.arquivos.includes(f));
  if (faltando.length) {
    console.error(`ERRO: a cena nao tem ${faltando.join(', ')}.`);
    console.error('Sem o splat nao ha o que ver; sem o octree o visitante atravessa parede,');
    console.error('e a cena abre bonita sem nada no console.');
    closeAll();
    process.exit(4);
  }
  const ausentes = ESPERADOS.filter((f) => !inv.arquivos.includes(f));
  if (ausentes.length) log(`  ATENCAO: sem ${ausentes.join(', ')} (a cena abre, o cartao fica pobre)`);
  const itens = inv.arquivos.filter((f) => f.startsWith('itens/')).length;
  log(`  fotos de ficha: ${itens}`);

  let pose = null;
  if (o.pose) {
    const p = o.pose.split(',').map(Number);
    if (p.length !== 5 || p.some(Number.isNaN)) {
      console.error('ERRO: --pose precisa de cinco numeros: "x,y,z,yaw,pitch".');
      closeAll();
      process.exit(2);
    }
    pose = p;
  }

  if (o.dryRun) {
    log('\n--dry-run: nada foi escrito.');
    closeAll();
    return;
  }

  passo('2. copia');
  const destino = join(config.scenesDir, o.id);
  // A PASTA VELHA SAI INTEIRA antes da copia. Copiar por cima deixaria arquivo
  // que a nova versao nao tem, e o visualizador o serviria como se fosse dela.
  if (existsSync(destino)) rmSync(destino, { recursive: true, force: true });
  mkdirSync(destino, { recursive: true });
  for (const rel of inv.arquivos) {
    const alvo = join(destino, rel);
    mkdirSync(dirname(alvo), { recursive: true });
    copyFileSync(join(o.origem, rel), alvo);
  }
  const copiado = inventaria(destino);
  log(`  ${copiado.arquivos.length.toLocaleString('pt-BR')} arquivos, ${(copiado.bytes / 2 ** 20).toFixed(1)} MiB`);

  passo('3. conferencia');
  // A CONFERENCIA COBRE A MESMA EXTENSAO DA ESCRITA: copiou N arquivos, confere
  // os N, por sha256 na origem e no destino. Comparar so o tamanho deixaria
  // passar copia truncada que casa por acaso, e comparar so a contagem nem isso.
  if (copiado.arquivos.length !== inv.arquivos.length) {
    console.error(`ERRO: copiou ${copiado.arquivos.length} de ${inv.arquivos.length} arquivos.`);
    closeAll();
    process.exit(5);
  }
  let divergentes = 0;
  for (const rel of inv.arquivos) {
    const [a, b] = await Promise.all([
      sha256(join(o.origem, rel)),
      sha256(join(destino, rel)),
    ]);
    if (a !== b) { console.error(`  DIVERGE ${rel}`); divergentes++; }
  }
  if (divergentes) {
    console.error(`ERRO: ${divergentes} arquivos divergem da origem.`);
    closeAll();
    process.exit(5);
  }
  log(`  ${inv.arquivos.length.toLocaleString('pt-BR')} arquivos conferidos por sha256, zero divergencias`);

  passo('4. catalogo');
  upsertScene({
    id: o.id,
    name: o.nome || o.id,
    description: o.descricao ?? null,
    local: o.local ?? null,
    captured_at: o.dataCaptura ?? null,
    keywords: o.keywords ? JSON.stringify(o.keywords.split(',').map((k) => k.trim())) : null,
    lon: o.lon,
    lat: o.lat,
    pose_x: pose ? pose[0] : null,
    pose_y: pose ? pose[1] : null,
    pose_z: pose ? pose[2] : null,
    pose_yaw: pose ? pose[3] : null,
    pose_pitch: pose ? pose[4] : null,
    velocidade: o.velocidade,
    fov: o.fov,
    bytes: copiado.bytes,
    file_count: copiado.arquivos.length,
    imported_at: new Date().toISOString(),
    published: 1,
  });
  if (o.lon == null || o.lat == null) {
    log('  ATENCAO: sem lon/lat a cena NAO ganha pino no mapa 2D, e so o catalogo a alcanca.');
  }
  if (!pose) {
    log('  ATENCAO: sem --pose o visitante entra na pose padrao do visualizador.');
  }

  log(`\n=== IMPORTADA: ${o.id} ===`);
  log(`basePath para o ebgeo_web: /api/v1/scenes/${o.id}`);
  closeAll();
}

main().catch((err) => {
  console.error(err);
  closeAll();
  process.exit(1);
});
