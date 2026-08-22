/**
 * Testes das partes puras da conversao: o envelope b3dm e a reescrita do
 * tileset. Nao dependem de banco, de rede nem do binario `ktx`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { abrirTile, tipoDeTile, leGerador } from '../scripts/lib/b3dm.js';
import { reescreveTileset, pontoDeNavegacao } from '../scripts/lib/tileset.js';

/** Monta um glb minimo valido (so o chunk JSON). */
function glbFalso(json = { asset: { version: '2.0' } }) {
  let corpo = Buffer.from(JSON.stringify(json), 'utf-8');
  const resto = corpo.length % 4;
  if (resto) corpo = Buffer.concat([corpo, Buffer.alloc(4 - resto, 0x20)]);
  const cabecalho = Buffer.alloc(12);
  cabecalho.write('glTF', 0, 'ascii');
  cabecalho.writeUInt32LE(2, 4);
  cabecalho.writeUInt32LE(12 + 8 + corpo.length, 8);
  const chunk = Buffer.alloc(8);
  chunk.writeUInt32LE(corpo.length, 0);
  chunk.write('JSON', 4, 'ascii');
  return Buffer.concat([cabecalho, chunk, corpo]);
}

/** Envelopa um glb em b3dm, com tabelas do tamanho pedido. */
function b3dmFalso(glb, { ftJSON = 0, btJSON = 0 } = {}) {
  const cab = Buffer.alloc(28);
  cab.write('b3dm', 0, 'ascii');
  cab.writeUInt32LE(1, 4);
  cab.writeUInt32LE(28 + ftJSON + btJSON + glb.length, 8);
  cab.writeUInt32LE(ftJSON, 12);
  cab.writeUInt32LE(0, 16);
  cab.writeUInt32LE(btJSON, 20);
  cab.writeUInt32LE(0, 24);
  return Buffer.concat([cab, Buffer.alloc(ftJSON, 0x20), Buffer.alloc(btJSON, 0x20), glb]);
}

test('abrirTile extrai o glb de dentro do b3dm', () => {
  const glb = glbFalso();
  const r = abrirTile(b3dmFalso(glb));
  assert.equal(r.glb.toString('ascii', 0, 4), 'glTF');
  assert.equal(r.glb.length, glb.length);
});

test('abrirTile deixa passar um glb que ja e glb', () => {
  const glb = glbFalso();
  const r = abrirTile(glb);
  assert.equal(r.glb, glb);
  assert.equal(r.temBatchTable, false);
});

test('abrirTile acusa batch table com conteudo', () => {
  // 2 bytes e "{}", tabela vazia, e nao conta como conteudo.
  assert.equal(abrirTile(b3dmFalso(glbFalso(), { btJSON: 2 })).temBatchTable, false);
  assert.equal(abrirTile(b3dmFalso(glbFalso(), { btJSON: 40 })).temBatchTable, true);
});

test('abrirTile recusa container que nao conhece', () => {
  assert.throws(() => abrirTile(Buffer.from('pnts0000')), /container nao suportado/);
});

test('tipoDeTile identifica os containers', () => {
  assert.equal(tipoDeTile(Buffer.from('glTF')), 'glb');
  assert.equal(tipoDeTile(Buffer.from('b3dm')), 'b3dm');
  assert.equal(tipoDeTile(Buffer.from('pnts')), 'pnts');
  assert.equal(tipoDeTile(Buffer.from('zzzz')), 'desconhecido');
});

test('reescreveTileset sobe a versao, troca .b3dm por .glb e poe o token', () => {
  const entrada = {
    asset: { version: '0.0', gltfUpAxis: 'Z' },
    root: {
      content: { uri: 'Data/a.b3dm' },
      children: [
        { content: { uri: 'Data/d000/tileset.json' } },
        { contents: [{ uri: 'Data/b0.b3dm' }, { uri: 'Data/b1.b3dm' }] },
      ],
    },
  };
  const r = reescreveTileset(entrada, 'abc123');

  assert.equal(r.json.asset.version, '1.1');
  assert.ok(!('gltfUpAxis' in r.json.asset), 'gltfUpAxis nao existe em 1.1');
  assert.equal(r.trocadas, 3);
  assert.equal(r.json.root.content.uri, 'Data/a.glb?v=abc123');
  assert.equal(r.json.root.children[0].content.uri, 'Data/d000/tileset.json?v=abc123');
  assert.deepEqual(r.uris, ['Data/a.glb', 'Data/d000/tileset.json', 'Data/b0.glb', 'Data/b1.glb']);
});

test('reescreveTileset nao mexe em uri absoluta', () => {
  const r = reescreveTileset({
    asset: { version: '1.0' },
    root: { content: { uri: 'https://outro.host/x.b3dm' } },
  }, 'tok');
  assert.equal(r.json.root.content.uri, 'https://outro.host/x.b3dm');
  assert.equal(r.uris.length, 0, 'uri externa nao entra na conferencia local');
});

test('reescreveTileset nao adultera tiling implicito', () => {
  const entrada = {
    asset: { version: '1.0' },
    root: {
      implicitTiling: { subdivisionScheme: 'QUADTREE', subtreeLevels: 3, availableLevels: 5 },
      content: { uri: 'tiles/{level}/{x}/{y}.glb' },
    },
  };
  const r = reescreveTileset(entrada, 'tok');
  // O template do conteudo nao leva token: a substituicao acontece no cliente,
  // e um "?v=" colado antes sairia no lugar errado da URL montada.
  assert.equal(r.json.root.content.uri, 'tiles/{level}/{x}/{y}.glb');
});

test('pontoDeNavegacao le properties em radianos', () => {
  // Ponte de Quatis, valores reais do tileset do acervo.
  const p = pontoDeNavegacao({
    properties: {
      Longitude: { minimum: -0.7730264695322793, maximum: -0.7729694491175817 },
      Latitude: { minimum: -0.39102686094733013, maximum: -0.39095892497573537 },
      Height: { minimum: 310.9124718771465, maximum: 369.1939446762866 },
    },
  });
  assert.ok(Math.abs(p.lon - (-44.2895)) < 0.001, `lon inesperado: ${p.lon}`);
  assert.ok(Math.abs(p.lat - (-22.4022)) < 0.001, `lat inesperado: ${p.lat}`);
  assert.ok(Math.abs(p.height - 340.05) < 0.1);
});

test('pontoDeNavegacao cai para boundingVolume.region', () => {
  const p = pontoDeNavegacao({
    root: { boundingVolume: { region: [-0.78, -0.40, -0.77, -0.39, 300, 400] } },
  });
  assert.ok(p.lon < 0 && p.lat < 0);
  assert.equal(p.height, 350);
});

test('pontoDeNavegacao devolve null quando so ha box', () => {
  assert.equal(pontoDeNavegacao({ root: { boundingVolume: { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] } } }), null);
});

test('leGerador tira o motor do JSON cru', () => {
  // O glTF-Transform carimba o proprio nome em asset.generator ja na LEITURA,
  // entao ler pelo Document publica "glTF-Transform" como proveniencia de todo
  // modelo do acervo. Este e o unico caminho em que o valor de origem sobrevive.
  const glb = glbFalso({ asset: { version: '2.0', generator: 'Agisoft Metashape' } });
  assert.equal(leGerador(glb), 'Agisoft Metashape');
  assert.equal(leGerador(glbFalso({ asset: { version: '2.0', generator: 'DJI Terra' } })), 'DJI Terra');
});

test('leGerador devolve null em vez de estourar com entrada estranha', () => {
  assert.equal(leGerador(Buffer.from('nao e glb')), null);
  assert.equal(leGerador(glbFalso({ asset: { version: '2.0' } })), null);
  assert.equal(leGerador(Buffer.alloc(0)), null);
});
