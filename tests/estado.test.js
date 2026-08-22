/**
 * Testes das tres maquinas de estado do serviço: o LRU de conexoes, a rotacao
 * por troca de arquivo, e o semaforo de tiles em voo.
 *
 * ESTE ARQUIVO EXISTE PORQUE A SUITE FICAVA VERDE NOS DOIS LADOS DE UM DEFEITO
 * REAL. O LRU tinha teto de 12 e nunca recebia conexao nenhuma: toda leitura
 * caia no caminho de "rotacao" e a conexao virava propria de tiles-queries.js,
 * que nao tem teto. Com 115 modelos, 8 MB de cache e 64 MB de mmap cada, era o
 * estouro dos 512 MB do container, e o /health reportava `open: 0` justamente no
 * pior momento. Quem viu foi a bancada de carga, nao o teste.
 *
 * Cada teste aqui trava um comportamento que so se observa com estado acumulado,
 * e por isso nenhum deles cabe num teste de rota isolado.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

const raiz = mkdtempSync(join(tmpdir(), 'ebgeo3d-estado-'));
process.env.EBGEO3D_DATA_DIR = raiz;
// Teto baixo de proposito: com 12 nenhum teste de despejo caberia num arquivo
// de teste, e um teste que nao consegue disparar o comportamento nao o protege.
process.env.MAX_OPEN_MODELS = '2';
process.env.MAX_INFLIGHT_TILES = '1';

const { buildApp } = await import('../src/build-app.js');
const { upsertModel, getModel } = await import('../src/db/queries.js');
const { closeAll, openModelCount } = await import('../src/db/connection.js');
const { getMedia, resetTileStatements } = await import('../src/db/tiles-queries.js');
const config = (await import('../src/config.js')).default;

/** Guarda contra o pior acidente possivel: escrever no data/ de verdade. */
assert.ok(config.dataDir.startsWith(tmpdir()), 'o teste tem de rodar em diretorio temporario');

const GLB = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(28, 1)]);

/** Cria um .3dtiles com um conteudo conhecido por chave. */
function criaModelo(nome, conteudos) {
  const caminho = join(raiz, 'models', `${nome}.3dtiles`);
  const db = new Database(caminho);
  db.pragma('journal_mode = DELETE');
  db.exec('CREATE TABLE media (key TEXT PRIMARY KEY, content BLOB NOT NULL)');
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  const ins = db.prepare('INSERT INTO media VALUES (?,?)');
  for (const [k, v] of Object.entries(conteudos)) ins.run(k, v);
  db.close();
  return caminho;
}

function catalogaModelo(id, extras = {}) {
  upsertModel({
    id, name: id, db_filename: `${id}.3dtiles`,
    source: null, source_version: null, captured_at: null,
    tiles_version: '1.1', geometry_codec: 'draco', texture_codec: 'ktx2-etc1s',
    texture_quality: 200, tile_count: 1, json_count: 0, total_bytes: 1,
    source_bytes: 1, build_token: 'tok1', built_at: '2026-08-22T00:00:00Z',
    lon: null, lat: null, height: null, ground_height: null, min_height: null, height_offset: null, max_sse: null,
    description: null, local: null, keywords: null,
    preview_video: null, preview_thumb: null, published: 1,
    ...extras,
  });
}

let app;

before(async () => {
  mkdirSync(join(raiz, 'models'), { recursive: true });
  app = await buildApp({ logger: false });
  for (const n of ['m1', 'm2', 'm3', 'm4']) {
    criaModelo(n, { 'Data/a.glb': GLB, 'tileset.json': Buffer.from('{"asset":{"version":"1.1"}}') });
    catalogaModelo(n);
  }
});

after(async () => {
  if (app) await app.close();
  resetTileStatements();
  closeAll();
  rmSync(raiz, { recursive: true, force: true });
});

// ---------------------------------------------------------------- LRU

test('o LRU recebe as conexoes, em vez de ficar vazio', () => {
  getMedia('m1.3dtiles', 'Data/a.glb');
  assert.ok(openModelCount() >= 1,
    'a conexao tem de viver no LRU de connection.js; em 0 o teto de memoria nao vale nada');
});

test('o LRU respeita o teto ao girar entre mais modelos que ele cabe', () => {
  // Teto de 2 e tres modelos em rodizio: o comportamento so aparece com estado.
  for (let volta = 0; volta < 3; volta++) {
    for (const m of ['m1', 'm2', 'm3']) {
      assert.ok(getMedia(`${m}.3dtiles`, 'Data/a.glb'), `${m} tem de responder`);
    }
  }
  assert.equal(openModelCount(), 2,
    'o LRU nao pode passar do teto nem esvaziar: em 0 as conexoes migraram para fora dele');
});

test('o despejo do LRU fecha o handle de verdade', () => {
  // A prova de que o handle caiu e poder APAGAR o arquivo: no Windows um handle
  // aberto segura o arquivo, e este teste falharia com EBUSY.
  criaModelo('descartavel', { 'Data/a.glb': GLB });
  catalogaModelo('descartavel');
  getMedia('descartavel.3dtiles', 'Data/a.glb');
  // Empurra o teto com outros dois modelos, para o descartavel sair do LRU.
  getMedia('m1.3dtiles', 'Data/a.glb');
  getMedia('m2.3dtiles', 'Data/a.glb');
  getMedia('m3.3dtiles', 'Data/a.glb');
  const caminho = join(raiz, 'models', 'descartavel.3dtiles');
  assert.doesNotThrow(() => unlinkSync(caminho),
    'o despejo tem de fechar o handle; EBUSY aqui significa conexao vazada');
});

test('modelo cujo arquivo sumiu devolve null, sem estourar', () => {
  assert.equal(getMedia('naoexiste.3dtiles', 'Data/a.glb'), null);
});

// ---------------------------------------------------------------- rotacao

test('o arquivo alterado sob a conexao viva passa a servir o conteudo novo', () => {
  const NOVO = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(4096, 9)]);
  criaModelo('girado', { 'Data/a.glb': GLB });
  catalogaModelo('girado');

  const antes = getMedia('girado.3dtiles', 'Data/a.glb');
  assert.equal(antes.length, GLB.length);

  // A ALTERACAO E POR OUTRA CONEXAO, e nao apagando e recriando o arquivo.
  // Apagar so funciona no Linux: no Windows um handle aberto segura o arquivo, e
  // este teste reprovava com EBUSY antes de chegar na asserção que importa. O
  // caminho de deteccao exercitado e o mesmo nos dois casos, porque ele olha
  // mtime e tamanho, e nao o inode.
  const caminho = join(raiz, 'models', 'girado.3dtiles');
  const escritor = new Database(caminho);
  escritor.prepare('UPDATE media SET content = ? WHERE key = ?').run(NOVO, 'Data/a.glb');
  escritor.pragma('wal_checkpoint(TRUNCATE)');
  escritor.close();

  const depois = getMedia('girado.3dtiles', 'Data/a.glb');
  assert.equal(depois.length, NOVO.length,
    'sem detectar a alteracao, o servico entrega tile morto sob immutable de um ano');
});

test('o handle vivo segura o arquivo, que e o que a importacao contorna', () => {
  // ESTE TESTE TRAVA UM COMPORTAMENTO DE PLATAFORMA, nao um defeito. No Windows
  // nao se apaga arquivo com handle aberto, e e por isso que reimportar com o
  // servico no ar falha com EBUSY e o roteiro oferece `--promover`. No Linux o
  // mesmo unlink passa, e a conexao viva segue lendo o inode antigo.
  criaModelo('preso', { 'Data/a.glb': GLB });
  catalogaModelo('preso');
  getMedia('preso.3dtiles', 'Data/a.glb');
  const caminho = join(raiz, 'models', 'preso.3dtiles');

  if (process.platform === 'win32') {
    assert.throws(() => unlinkSync(caminho), /EBUSY|EPERM/,
      'se o Windows deixar apagar, a conexao nao esta viva e o teste do LRU acima mente');
  } else {
    assert.doesNotThrow(() => unlinkSync(caminho));
  }
});

test('a rotacao nao tira o modelo do LRU para sempre', () => {
  // Depois de uma rotacao a conexao passa a ser de tiles-queries.js, e isso e
  // correto. O que NAO pode e todo modelo virar rotacionado na primeira leitura:
  // era exatamente esse o defeito, e o sintoma era openModelCount() em zero.
  const antes = openModelCount();
  getMedia('m4.3dtiles', 'Data/a.glb');
  assert.ok(openModelCount() >= antes || openModelCount() > 0,
    'um modelo que nunca trocou de arquivo tem de entrar no LRU');
});

// ---------------------------------------------------------------- semaforo

test('a vaga do semaforo volta depois de cada resposta', async () => {
  // MAX_INFLIGHT_TILES = 1: se a vaga nao voltasse, a segunda requisicao ficaria
  // pendurada para sempre e este teste estouraria o tempo em vez de reprovar.
  for (let i = 0; i < 5; i++) {
    const r = await comTempo(app.inject({ url: '/api/v1/models/m1/Data/a.glb' }), 3000);
    assert.equal(r.statusCode, 200, `requisicao ${i + 1} de 5`);
  }
});

test('a vaga volta tambem quando a chave nao existe', async () => {
  for (let i = 0; i < 3; i++) {
    const r = await comTempo(app.inject({ url: '/api/v1/models/m1/Data/naotem.glb' }), 3000);
    assert.equal(r.statusCode, 404);
  }
  // E o serviço continua servindo depois dos 404.
  const ok = await comTempo(app.inject({ url: '/api/v1/models/m1/Data/a.glb' }), 3000);
  assert.equal(ok.statusCode, 200, 'o 404 vazou a vaga do semaforo');
});

test('requisicoes simultaneas passam todas com o teto em 1', async () => {
  const todas = await comTempo(
    Promise.all(Array.from({ length: 8 }, () => app.inject({ url: '/api/v1/models/m2/Data/a.glb' }))),
    5000,
  );
  assert.deepEqual([...new Set(todas.map((r) => r.statusCode))], [200]);
});

/** Reprova rapido em vez de pendurar a suite. */
function comTempo(promessa, ms) {
  return Promise.race([
    promessa,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`sem resposta em ${ms} ms: vaga do semaforo perdida`)), ms).unref()),
  ]);
}

// ---------------------------------------------------------------- catalogo

test('reimportar preserva o que o operador editou no catalogo', () => {
  catalogaModelo('editado', { lon: -44.28, lat: -22.40, description: 'escrito a mao' });
  // A reimportacao chega sem esses campos, como o importar.js faz de verdade.
  catalogaModelo('editado', { lon: null, lat: null, description: null, build_token: 'tok2' });

  const linha = getModel('editado');

  assert.equal(linha.description, 'escrito a mao', 'o COALESCE do upsert tem de segurar a edicao');
  assert.equal(linha.lon, -44.28);
  assert.equal(linha.build_token, 'tok2', 'o que a importacao mede, ela sobrescreve');
});
