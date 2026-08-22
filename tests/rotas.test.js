/**
 * Testes das rotas, contra um banco de verdade montado num diretorio temporario.
 *
 * MONTA O APP PELO build-app.js, que e o mesmo grafo de rotas que o server.js
 * sobe. Testar um app montado a mao no teste ja deixou rota de fora no
 * ebgeo_360: passava nos testes e respondia 404 no servico vivo.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

const raiz = mkdtempSync(join(tmpdir(), 'ebgeo3d-teste-'));
process.env.EBGEO3D_DATA_DIR = raiz;

const { buildApp } = await import('../src/build-app.js');
const { upsertModel } = await import('../src/db/queries.js');
const { closeAll } = await import('../src/db/connection.js');
const { resetTileStatements } = await import('../src/db/tiles-queries.js');
const { normalizaChave } = await import('../src/routes/tiles.js');

const TILESET = JSON.stringify({
  asset: { version: '1.1' },
  geometricError: 100,
  root: { boundingVolume: { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] }, geometricError: 10, content: { uri: 'Data/a.glb?v=tok1' } },
});
const GLB = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(28)]);

let app;

before(async () => {
  mkdirSync(join(raiz, 'models'), { recursive: true });
  const db = new Database(join(raiz, 'models', 'teste.3dtiles'));
  db.exec('CREATE TABLE media (key TEXT PRIMARY KEY, content BLOB NOT NULL)');
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO media VALUES (?,?)').run('tileset.json', Buffer.from(TILESET));
  db.prepare('INSERT INTO media VALUES (?,?)').run('Data/a.glb', GLB);
  db.close();

  app = await buildApp({ logger: false });

  upsertModel({
    id: 'teste', name: 'Modelo de teste', db_filename: 'teste.3dtiles',
    source: 'Agisoft Metashape', source_version: '1.0', captured_at: null,
    tiles_version: '1.1', geometry_codec: 'draco', texture_codec: 'ktx2-etc1s',
    texture_quality: 200, tile_count: 1, json_count: 1, total_bytes: 999,
    source_bytes: 900, build_token: 'tok1', built_at: '2026-08-22T00:00:00Z',
    lon: -44.29, lat: -22.40, height: 800, height_offset: 0, max_sse: null,
    description: null, local: null, keywords: '["ponte"]',
    preview_video: null, preview_thumb: null, published: 1,
  });
  upsertModel({
    id: 'oculto', name: 'Nao publicado', db_filename: 'teste.3dtiles',
    source: null, source_version: null, captured_at: null,
    tiles_version: '1.1', geometry_codec: 'draco', texture_codec: 'ktx2-etc1s',
    texture_quality: 200, tile_count: 1, json_count: 1, total_bytes: 1,
    source_bytes: 1, build_token: 'tok1', built_at: '2026-08-22T00:00:00Z',
    lon: null, lat: null, height: null, height_offset: null, max_sse: null,
    description: null, local: null, keywords: null,
    preview_video: null, preview_thumb: null, published: 0,
  });
});

after(async () => {
  if (app) await app.close();
  resetTileStatements();
  closeAll();
  rmSync(raiz, { recursive: true, force: true });
});

test('/health responde com a contagem', async () => {
  const r = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.equal(j.status, 'ok');
  assert.equal(j.models, 1, 'o modelo nao publicado nao entra na contagem');
});

test('o catalogo sai no formato do config.tilesets', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/v1/models?base=/ebgeo_3d' });
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.equal(j.count, 1);
  const t = j.tilesets[0];
  assert.equal(t.id, 'teste');
  assert.equal(t.type, '3dtiles');
  assert.equal(t.url, '/ebgeo_3d/api/v1/models/teste/tileset.json');
  assert.deepEqual(t.keywords, ['ponte']);
  assert.deepEqual(t.locate, { lon: -44.29, lat: -22.40, height: 800 });
});

test('o tileset.json vem com no-cache e ETag', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/v1/models/teste/tileset.json' });
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-type'], /application\/json/);
  assert.equal(r.headers['cache-control'], 'public, no-cache');
  assert.ok(r.headers.etag, 'sem ETag o no-cache custa o corpo inteiro a cada visita');
  assert.equal(JSON.parse(r.body).asset.version, '1.1');
});

test('o tile vem imutavel, com o tipo de glTF binario', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/v1/models/teste/Data/a.glb?v=tok1' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['content-type'], 'model/gltf-binary');
  assert.match(r.headers['cache-control'], /immutable/);
  assert.equal(r.rawPayload.subarray(0, 4).toString('ascii'), 'glTF');
});

test('token velho na URL ainda serve o tile de hoje', async () => {
  // Depois de uma reimportacao o cliente ainda segura o tileset velho por alguns
  // instantes. Recusar o token antigo pintaria a cena de buraco.
  const r = await app.inject({ method: 'GET', url: '/api/v1/models/teste/Data/a.glb?v=umtokenqualquer' });
  assert.equal(r.statusCode, 200);
});

test('If-None-Match devolve 304 sem corpo', async () => {
  const primeira = await app.inject({ method: 'GET', url: '/api/v1/models/teste/Data/a.glb' });
  const etag = primeira.headers.etag;
  const segunda = await app.inject({
    method: 'GET',
    url: '/api/v1/models/teste/Data/a.glb',
    headers: { 'if-none-match': etag },
  });
  assert.equal(segunda.statusCode, 304);
  assert.equal(segunda.rawPayload.length, 0);
});

test('chave inexistente e 404, modelo inexistente tambem', async () => {
  assert.equal((await app.inject({ url: '/api/v1/models/teste/Data/naotem.glb' })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/v1/models/naotem/tileset.json' })).statusCode, 404);
});

test('modelo nao publicado nao e servido', async () => {
  assert.equal((await app.inject({ url: '/api/v1/models/oculto/tileset.json' })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/v1/models/oculto.json' })).statusCode, 404);
});

test('chave que sobe de diretorio e recusada', async () => {
  const r = await app.inject({ url: '/api/v1/models/teste/..%2F..%2Fsegredo' });
  assert.equal(r.statusCode, 400);
});

test('normalizaChave rejeita travessia e aceita caminho comum', () => {
  assert.equal(normalizaChave('Data/a.glb'), 'Data/a.glb');
  assert.equal(normalizaChave('/Data/a.glb'), 'Data/a.glb');
  assert.equal(normalizaChave('Data/a.glb?v=1'), 'Data/a.glb');
  assert.equal(normalizaChave('Data\\a.glb'), 'Data/a.glb');
  assert.equal(normalizaChave('../x'), null);
  assert.equal(normalizaChave('a/../b'), null);
  assert.equal(normalizaChave(''), null);
  assert.equal(normalizaChave('%ZZ'), null);
});
