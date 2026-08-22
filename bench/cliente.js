#!/usr/bin/env node

/**
 * @module bench/cliente
 * @description Servidor estatico da bancada de CLIENTE (bench/cesium.html).
 *
 * A bancada precisa de duas raizes: a pasta `bench/` deste repositorio e o
 * build do CesiumJS, que tem centenas de MiB e nao entra aqui. Este servidor
 * junta as duas, para a medida nao depender de alguem copiar arquivo a mao.
 *
 * O diretorio do Cesium sai de `EBGEO3D_CESIUM_DIR`. Num checkout do ebgeo_web
 * ele e `<ebgeo_web>/public/vendors/cesium`.
 *
 * Uso:
 *   EBGEO3D_CESIUM_DIR=... node bench/cliente.js [--porta 8090]
 */

import { createServer } from 'node:http';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { join, extname, resolve, sep, basename } from 'node:path';
import { existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const v = (n, p) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : p; };
const PORTA = Number(v('--porta', 8090));

const RAIZ_BENCH = resolve(import.meta.dirname);
const RAIZ_CESIUM = resolve(process.env.EBGEO3D_CESIUM_DIR || '');

if (!process.env.EBGEO3D_CESIUM_DIR || !existsSync(join(RAIZ_CESIUM, 'Cesium.js'))) {
  console.error('ERRO: EBGEO3D_CESIUM_DIR nao aponta um build do CesiumJS.');
  console.error('Esperado um diretorio que contenha Cesium.js, Workers/ e Assets/.');
  console.error('Num checkout do ebgeo_web: <ebgeo_web>/public/vendors/cesium');
  process.exit(2);
}

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.ktx2': 'image/ktx2',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml',
};

/** Resolve a URL numa das duas raizes, barrando travessia. */
function paraCaminho(url) {
  const limpo = decodeURIComponent(url.split('?')[0]);
  if (limpo.startsWith('/cesium/')) {
    const alvo = resolve(join(RAIZ_CESIUM, limpo.slice('/cesium/'.length)));
    return alvo.startsWith(RAIZ_CESIUM + sep) ? alvo : null;
  }
  const rel = limpo === '/' ? '/cesium.html' : limpo;
  const alvo = resolve(join(RAIZ_BENCH, rel));
  return alvo.startsWith(RAIZ_BENCH + sep) ? alvo : null;
}

const DIR_CAPTURAS = join(RAIZ_BENCH, 'capturas');

/**
 * Recebe uma captura do framebuffer da bancada e grava em bench/capturas/.
 *
 * POR QUE A BANCADA CAPTURA, E NAO O NAVEGADOR. Com a aba oculta o compositor
 * do Chrome nao apresenta o quadro, e `Page.captureScreenshot` do CDP estoura o
 * tempo. O framebuffer do WebGL, esse existe: `canvas.toDataURL` o le direto,
 * desde que o Viewer suba com `preserveDrawingBuffer`.
 *
 * A contagem de tile diz quanto custou; so a imagem diz se ficou bom.
 */
async function recebeCaptura(req, res) {
  const pedacos = [];
  let bytes = 0;
  for await (const p of req) {
    bytes += p.length;
    if (bytes > 64 * 1024 * 1024) { res.writeHead(413).end('captura grande demais'); return; }
    pedacos.push(p);
  }
  let corpo;
  try {
    corpo = JSON.parse(Buffer.concat(pedacos).toString('utf-8'));
  } catch {
    res.writeHead(400).end('json invalido');
    return;
  }
  const nome = basename(String(corpo.nome || 'captura')).replace(/[^a-zA-Z0-9._-]/g, '_');
  const m = /^data:image\/(png|jpeg);base64,(.+)$/s.exec(String(corpo.dataURL || ''));
  if (!m) { res.writeHead(400).end('dataURL invalido'); return; }
  await mkdir(DIR_CAPTURAS, { recursive: true });
  const arquivo = join(DIR_CAPTURAS, `${nome}.${m[1] === 'jpeg' ? 'jpg' : 'png'}`);
  await writeFile(arquivo, Buffer.from(m[2], 'base64'));
  console.log(`captura ${arquivo}`);
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ arquivo }));
}

createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/captura') { await recebeCaptura(req, res); return; }
  const caminho = paraCaminho(req.url);
  if (!caminho) { res.writeHead(403).end('fora da raiz'); return; }
  try {
    const s = await stat(caminho);
    if (!s.isFile()) throw new Error('nao e arquivo');
    const corpo = await readFile(caminho);
    res.writeHead(200, {
      'Content-Type': TIPOS[extname(caminho).toLowerCase()] || 'application/octet-stream',
      'Content-Length': corpo.length,
      // A BANCADA NAO PODE MEDIR CACHE DO NAVEGADOR SEM QUERER.
      'Cache-Control': 'no-store',
    });
    res.end(corpo);
  } catch {
    res.writeHead(404).end('nao encontrado');
  }
}).listen(PORTA, '127.0.0.1', () => {
  console.log(`bancada de cliente em http://127.0.0.1:${PORTA}/`);
  console.log(`  bench   ${RAIZ_BENCH}`);
  console.log(`  cesium  ${RAIZ_CESIUM}`);
  console.log('O servico ebgeo_3d tem de estar no ar na porta 8082.');
});
