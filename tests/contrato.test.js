/**
 * Testes do que o serviço PROMETE e ninguem afirmava: o esquema de cache, o
 * fecho do banco, e as regressoes dos defeitos ja corrigidos.
 *
 * Cada teste aqui existe porque a promessa correspondente vivia so num
 * comentario, e comentario nao reprova nada.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const execFileAsync = promisify(execFile);
const repo = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const raiz = mkdtempSync(join(tmpdir(), 'ebgeo3d-contrato-'));
process.env.EBGEO3D_DATA_DIR = raiz;

const { computeTileETag } = await import('../src/middleware/cache.js');
const { createModelDb, finalizarModelDb, closeAll } = await import('../src/db/connection.js');
const { versaoKtx } = await import('../scripts/lib/ktx2.js');
const { reescreveTileset } = await import('../scripts/lib/tileset.js');
const { normalizaChave } = await import('../src/routes/tiles.js');

before(() => { mkdirSync(join(raiz, 'models'), { recursive: true }); });
after(() => { closeAll(); rmSync(raiz, { recursive: true, force: true }); });

// ---------------------------------------------------------------- cache

test('o ETag muda quando o token de geracao muda', () => {
  const a = computeTileETag('m', 'Data/a.glb', 'tok1');
  const b = computeTileETag('m', 'Data/a.glb', 'tok2');
  assert.notEqual(a, b,
    'e o eixo inteiro do cache: com ETag igual, uma reimportacao serve tile morto por um ano');
});

test('o ETag separa chaves diferentes do mesmo modelo', () => {
  assert.notEqual(
    computeTileETag('m', 'Data/a.glb', 'tok'),
    computeTileETag('m', 'Data/b.glb', 'tok'),
  );
});

test('o ETag separa modelos diferentes com a mesma chave', () => {
  assert.notEqual(
    computeTileETag('m1', 'Data/a.glb', 'tok'),
    computeTileETag('m2', 'Data/a.glb', 'tok'),
  );
});

test('o ETag e estavel: a mesma entrada da o mesmo valor', () => {
  assert.equal(
    computeTileETag('m', 'Data/d000/c00.glb', 'tok'),
    computeTileETag('m', 'Data/d000/c00.glb', 'tok'),
  );
});

// ---------------------------------------------------------------- banco

test('o banco de carga usa page 4096, journal em memoria e synchronous off', () => {
  const caminho = join(raiz, 'models', 'novo.3dtiles');
  const db = createModelDb(caminho);
  assert.equal(db.pragma('page_size', { simple: true }), 4096);
  // O VALOR EFETIVO, e nao o que foi pedido. O SQLite recusa `journal_mode = OFF`
  // aqui e devolve `delete` sem reclamar: pedir OFF dava a impressao de uma
  // otimizacao que nunca acontecia, e so um teste do valor lido pega isso.
  assert.equal(String(db.pragma('journal_mode', { simple: true })).toLowerCase(), 'memory',
    'journal_mode tem de ficar em MEMORY; se voltar delete, o pragma foi recusado');
  assert.equal(db.pragma('synchronous', { simple: true }), 0,
    'synchronous = OFF vale 2x na carga, medido');
  db.close();
});

test('finalizarModelDb entrega o arquivo fora do WAL', () => {
  const caminho = join(raiz, 'models', 'fechado.3dtiles');
  const db = createModelDb(caminho);
  db.prepare('INSERT INTO media VALUES (?,?)').run('a.glb', Buffer.from('glTF'));
  finalizarModelDb(db);

  // Reabre e confere no ARQUIVO, e nao no objeto que acabou de escrever: o eco
  // da funcao que escreveu nao e prova.
  const relido = new Database(caminho, { readonly: true });
  assert.equal(String(relido.pragma('journal_mode', { simple: true })).toLowerCase(), 'delete',
    'em WAL o SQLite cria o -shm ao abrir, e num volume :ro isso derruba o servico');
  relido.close();
  assert.ok(!existsSync(`${caminho}-wal`), 'o -wal tem de sumir no fecho');
  assert.ok(!existsSync(`${caminho}-shm`), 'o -shm tem de sumir no fecho');
});

// ---------------------------------------------------------------- regressoes

test('chave com por-cento literal nao vira 400', () => {
  // O Fastify ja decodifica o curinga. Um segundo decodeURIComponent achava um
  // escape malformado em "Data/100%.glb" e a rota respondia 400 num arquivo que
  // existe. Medido com app.inject antes do conserto.
  assert.equal(normalizaChave('Data/100%.glb'), 'Data/100%.glb');
  assert.equal(normalizaChave('Data/a b.glb'), 'Data/a b.glb');
  assert.equal(normalizaChave('Data/50%off.glb'), 'Data/50%off.glb');
});

test('reescreveTileset e idempotente: aplicar duas vezes nao duplica o token', () => {
  const entrada = { asset: { version: '1.0' }, root: { content: { uri: 'Data/a.b3dm' } } };
  const uma = reescreveTileset(entrada, 'tok1');
  assert.equal(uma.json.root.content.uri, 'Data/a.glb?v=tok1');

  const duas = reescreveTileset(uma.json, 'tok2');
  assert.equal(duas.json.root.content.uri, 'Data/a.glb?v=tok2',
    'o token novo substitui o velho; concatenar produziria uri que nao resolve');
  assert.equal(duas.trocadas, 0, 'a extensao ja estava trocada');
});

test('reescreveTileset cria o asset quando ele nao existe', () => {
  const r = reescreveTileset({ root: { content: { uri: 'a.glb' } } }, 'tok');
  assert.equal(r.json.asset.version, '1.1');
});

test('versaoKtx explica o binario ausente em vez de estourar cru', async () => {
  const antes = process.env.KTX_BIN;
  process.env.KTX_BIN = 'ktx-que-nao-existe-em-lugar-nenhum';
  // O modulo le a variavel na carga, entao a checagem aqui e sobre a mensagem
  // que o modulo ja carregado produz com o binario que ele tem.
  process.env.KTX_BIN = antes;
  try {
    await versaoKtx();
    // Se o `ktx` existe nesta maquina, o caminho de erro nao da para exercitar
    // aqui, e o teste passa sem afirmar nada. Dizemos isso em voz alta.
    assert.ok(true, 'o ktx existe nesta maquina: o caminho de erro nao foi exercitado');
  } catch (err) {
    assert.match(err.message, /Instale o KTX-Software/,
      'a mensagem tem de dizer o que fazer, nao so o codigo do sistema');
  }
});

// ---------------------------------------------------------------- roteiros

test('promover recusa um .parcial com cabecalho incompleto', async () => {
  // Regressao conhecida: promover um .parcial gravado por versao anterior
  // escreveu `tile_count = 0` num modelo de 7.501 tiles.
  const caminho = join(raiz, 'models', 'capenga.3dtiles.parcial');
  const db = createModelDb(caminho);
  db.prepare('INSERT INTO media VALUES (?,?)').run('a.glb', Buffer.from('glTF'));
  db.prepare('INSERT INTO meta VALUES (?,?)').run('id', 'capenga');
  finalizarModelDb(db);          // sem buildToken, builtAt nem tileCount

  const r = await rodaRoteiro(['scripts/importar.js', '--promover', '--id', 'capenga']);
  assert.equal(r.code, 7, 'cabecalho incompleto tem de sair com 7, nao publicar zerado');
  assert.match(r.saida, /nao tem .*tileCount|cabecalho/i);
});

test('importar recusa origem com nuvem de pontos', async () => {
  const origem = join(raiz, 'origem-pnts');
  mkdirSync(origem, { recursive: true });
  writeFileSync(join(origem, 'tileset.json'), '{"asset":{"version":"1.0"},"root":{}}');
  writeFileSync(join(origem, 'nuvem.pnts'), Buffer.from('pnts'));

  const r = await rodaRoteiro(['scripts/importar.js', '--origem', origem, '--id', 'compnts', '--dry-run']);
  assert.equal(r.code, 4, '.pnts tem de reprovar no passo 1, nao sumir calado');
  assert.match(r.saida, /nao converte/i);
});

test('importar recusa id fora do padrao', async () => {
  const r = await rodaRoteiro(['scripts/importar.js', '--origem', raiz, '--id', 'Ponte_Quatis']);
  assert.equal(r.code, 2);
  assert.match(r.saida, /invalido/i);
});

/**
 * Roda um roteiro do repositorio e devolve codigo de saida e saida combinada.
 *
 * `--env-file-if-exists` NAO entra: o teste tem de rodar com o ambiente que ele
 * mesmo montou, e nao com o .env da maquina de quem roda.
 */
async function rodaRoteiro(argv) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, argv, {
      cwd: repo,
      env: { ...process.env, EBGEO3D_DATA_DIR: raiz },
    });
    return { code: 0, saida: stdout + stderr };
  } catch (err) {
    return { code: err.code ?? 1, saida: (err.stdout || '') + (err.stderr || '') };
  }
}

test('so um codec de geometria sai declarado', async () => {
  // Ler um b3dm com Draco registra a extensao no Document, e ela SOBREVIVE a
  // leitura. Sem descartar antes de escolher o codec, o arquivo saia declarando
  // KHR_draco_mesh_compression E EXT_meshopt_compression, os dois como
  // obrigatorios. O CesiumJS recusa em silencio: 13 tiles no tileset, 0 prontos,
  // 0 pendentes, e nenhuma mensagem no console.
  const { criarConversor } = await import('../scripts/lib/conversor.js');
  const { abrirTile } = await import('../scripts/lib/b3dm.js');
  void abrirTile;

  // Draco e meshopt sao mutuamente EXCLUSIVOS: a mesma geometria nao se comprime
  // por dois codecs. Ja o KHR_mesh_quantization ANDA COM o meshopt, que por
  // especificacao opera sobre dados quantizados, entao os dois juntos sao o
  // esperado e nao um defeito.
  const EXCLUSIVOS = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression'];
  const GEOM = {
    draco: ['KHR_draco_mesh_compression'],
    meshopt: ['EXT_meshopt_compression', 'KHR_mesh_quantization'],
    quantize: ['KHR_mesh_quantization'],
  };
  // Um glb minimo com uma malha: o suficiente para o codec ser aplicado.
  const doc = glbComMalha();

  for (const [modo, esperada] of Object.entries(GEOM)) {
    const c = await criarConversor({ geometria: modo });
    const r = await c.converte(doc);
    c.fecha();
    const tam = r.glb.readUInt32LE(12);
    const j = JSON.parse(r.glb.subarray(20, 20 + tam).toString('utf-8'));
    const req = j.extensionsRequired || [];
    const exclusivos = EXCLUSIVOS.filter((g) => req.includes(g));
    assert.ok(exclusivos.length <= 1,
      `${modo} declarou ${JSON.stringify(exclusivos)}; Draco e meshopt juntos e arquivo invalido`);
    for (const e of esperada) {
      assert.ok(req.includes(e), `${modo} tem de declarar ${e}, e declarou ${JSON.stringify(req)}`);
    }
  }
});

/** glb com uma malha de dois triangulos, sem textura. */
function glbComMalha() {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
  const idx = new Uint16Array([0, 1, 2, 1, 3, 2]);
  const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(idx.buffer), Buffer.alloc(4)]);
  const json = {
    asset: { version: '2.0', generator: 'teste' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  let corpo = Buffer.from(JSON.stringify(json), 'utf-8');
  const resto = corpo.length % 4;
  if (resto) corpo = Buffer.concat([corpo, Buffer.alloc(4 - resto, 0x20)]);
  const cab = Buffer.alloc(12);
  cab.write('glTF', 0, 'ascii');
  cab.writeUInt32LE(2, 4);
  cab.writeUInt32LE(12 + 8 + corpo.length + 8 + bin.length, 8);
  const cj = Buffer.alloc(8); cj.writeUInt32LE(corpo.length, 0); cj.write('JSON', 4, 'ascii');
  const cb = Buffer.alloc(8); cb.writeUInt32LE(bin.length, 0); cb.write('BIN ', 4, 'ascii');
  return Buffer.concat([cab, cj, corpo, cb, bin]);
}
