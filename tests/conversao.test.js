/**
 * Testes das partes puras da conversao: o envelope b3dm e a reescrita do
 * tileset. Nao dependem de banco, de rede nem do binario `ktx`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { abrirTile, tipoDeTile, leGerador } from '../scripts/lib/b3dm.js';
import { dimensaoAlvo } from '../scripts/lib/ktx2.js';
import {
  reescreveTileset, pontoDeNavegacao, envelopeGeodesico, ESCALA_GE, MAX_TEXTURA,
} from '../scripts/lib/tileset.js';

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

test('a escala do geometricError deixa o "sempre refine" do DJI intacto', () => {
  const entrada = {
    asset: { version: '1.0' },
    geometricError: 1527.47,
    root: {
      geometricError: 10000000000,          // o "sempre refine" do DJI
      content: { uri: 'Block/x.json' },
      children: [
        { geometricError: 6.193, content: { uri: 'a.b3dm' } },
        { geometricError: 0.048, content: { uri: 'b.b3dm' } },
      ],
    },
  };
  const r = reescreveTileset(entrada, 'tok', { escalaGe: 16 });

  assert.equal(r.json.geometricError, 1527.47 * 16);
  assert.equal(r.json.root.geometricError, 10000000000,
    'multiplicar o 1e10 nao muda o comportamento e so suja o arquivo');
  assert.ok(Math.abs(r.json.root.children[0].geometricError - 6.193 * 16) < 1e-9);
  assert.ok(Math.abs(r.json.root.children[1].geometricError - 0.048 * 16) < 1e-9);
  assert.equal(r.escalados, 3, 'os tres finitos, e nao o 1e10');
});

test('sem escala o geometricError nao e tocado', () => {
  const r = reescreveTileset({ asset: { version: '1.1' }, root: { geometricError: 7.221, content: { uri: 'a.glb' } } }, 'tok');
  assert.equal(r.json.root.geometricError, 7.221);
  assert.equal(r.escalados, 0);
});

test('o fator do DJI Terra e 16, e so ele tem fator', () => {
  // O 16 nao e escolha de gosto: e o mesmo divisor que o config de producao
  // aplicava a mao no maximumScreenSpaceError dos 6 modelos do DJI.
  assert.equal(ESCALA_GE['DJI Terra'], 16);
  assert.equal(ESCALA_GE['Agisoft Metashape'], undefined,
    'o Metashape escala o geometricError certo e nao pode ser tocado');
});

/* ===================================================================== */
/* envelopeGeodesico                                                     */
/* ===================================================================== */

/**
 * Matriz ENU->ECEF de um ponto, no formato column-major do 3D Tiles.
 * E o `transform` que Metashape e DJI Terra gravam no root do tileset externo.
 */
function enuParaEcef(lonGrau, latGrau, altura) {
  const lon = (lonGrau * Math.PI) / 180;
  const lat = (latGrau * Math.PI) / 180;
  const a = 6378137.0;
  const e2 = (1 / 298.257223563) * (2 - 1 / 298.257223563);
  const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  const x = (n + altura) * Math.cos(lat) * Math.cos(lon);
  const y = (n + altura) * Math.cos(lat) * Math.sin(lon);
  const z = (n * (1 - e2) + altura) * Math.sin(lat);
  const sl = Math.sin(lon); const cl = Math.cos(lon);
  const sf = Math.sin(lat); const cf = Math.cos(lat);
  return [
    -sl, cl, 0, 0,
    -sf * cl, -sf * sl, cf, 0,
    cf * cl, cf * sl, sf, 0,
    x, y, z, 1,
  ];
}

const ALVO = { lon: -53.374417, lat: -29.626104, altura: 62.3 };

test('envelopeGeodesico resolve o transform do tileset externo', () => {
  // Raiz sem transform, apontando um tileset externo que carrega o ENU->ECEF.
  // E a forma exata do acervo: o box do tile de conteudo e LOCAL.
  const docs = new Map([
    ['tileset.json', {
      asset: { version: '1.1' },
      root: {
        geometricError: 100,
        boundingVolume: { box: [0, 0, 0, 500, 0, 0, 0, 500, 0, 0, 0, 100] },
        content: { uri: 'Data/d0/tileset.json' },
      },
    }],
    ['Data/d0/tileset.json', {
      asset: { version: '1.1' },
      root: {
        transform: enuParaEcef(ALVO.lon, ALVO.lat, ALVO.altura),
        geometricError: 10,
        boundingVolume: { box: [0, 0, 0, 50, 0, 0, 0, 50, 0, 0, 0, 5] },
        content: { uri: 'c0.glb' },
      },
    }],
  ]);

  const e = envelopeGeodesico(docs);
  assert.ok(e, 'o envelope tem de fechar');
  assert.ok(Math.abs(e.lon - ALVO.lon) < 1e-4, `lon ${e.lon}`);
  assert.ok(Math.abs(e.lat - ALVO.lat) < 1e-4, `lat ${e.lat}`);
  assert.ok(Math.abs(e.hChao - ALVO.altura) < 6, `chao ${e.hChao}`);
  assert.equal(e.amostras, 8, 'um tile de conteudo rende os 8 cantos do box');

  // O DEFEITO QUE ESTE TESTE TRAVA: ler o box sem aplicar o transform poe o
  // modelo perto de (0, 0), no golfo da Guine. Aqui a latitude tem de ser a de
  // Dona Francisca, e nao um numero perto de zero.
  assert.ok(Math.abs(e.lat) > 20, 'o transform foi ignorado: latitude perto do equador');
});

test('envelopeGeodesico ignora o tile que nao tem geometria', () => {
  // So o root, que aponta um externo INEXISTENTE: nao ha conteudo para medir.
  const docs = new Map([
    ['tileset.json', {
      asset: { version: '1.1' },
      root: {
        geometricError: 100,
        boundingVolume: { box: [0, 0, 0, 500, 0, 0, 0, 500, 0, 0, 0, 100] },
        content: { uri: 'Data/sumiu/tileset.json' },
      },
    }],
  ]);
  assert.equal(envelopeGeodesico(docs), null);
});

test('envelopeGeodesico nao entra duas vezes no mesmo tileset externo', () => {
  // Dois tiles apontando o MESMO externo. Sem a guarda de visitados uma arvore
  // com referencia circular travaria o importador.
  const t = enuParaEcef(ALVO.lon, ALVO.lat, ALVO.altura);
  const docs = new Map([
    ['tileset.json', {
      root: {
        boundingVolume: { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
        children: [
          { boundingVolume: { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] }, content: { uri: 'e.json' } },
          { boundingVolume: { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] }, content: { uri: 'e.json' } },
        ],
      },
    }],
    ['e.json', {
      root: {
        transform: t,
        boundingVolume: { box: [0, 0, 0, 5, 0, 0, 0, 5, 0, 0, 0, 5] },
        content: { uri: 'c.glb' },
      },
    }],
  ]);
  assert.equal(envelopeGeodesico(docs).amostras, 8);
});

/* ===================================================================== */
/* dimensaoAlvo: o teto de textura                                       */
/* ===================================================================== */

test('sem teto, dimensaoAlvo so alinha ao bloco de 4', () => {
  assert.deepEqual(dimensaoAlvo(1024, 1024), { largura: 1024, altura: 1024 });
  assert.deepEqual(dimensaoAlvo(1023, 511), { largura: 1020, altura: 508 });
  assert.deepEqual(dimensaoAlvo(3, 3), { largura: 4, altura: 4 });
});

test('o teto reduz o LADO MAIOR e preserva a proporcao', () => {
  // 1024x1024 -> 512x512: o caso do DJI Terra.
  assert.deepEqual(dimensaoAlvo(1024, 1024, 512), { largura: 512, altura: 512 });
  // 1024x512 -> 512x256. Reduzir os dois lados ao teto DEFORMARIA a textura, e
  // a UV do tile passaria a apontar para o pixel errado.
  assert.deepEqual(dimensaoAlvo(1024, 512, 512), { largura: 512, altura: 256 });
  assert.deepEqual(dimensaoAlvo(512, 1024, 512), { largura: 256, altura: 512 });
});

test('o teto nao AUMENTA textura que ja esta abaixo dele', () => {
  // O acervo do Metashape e quase todo 256x256 e 512x256: o teto tem de ser
  // inerte ali, e nao ampliar nada.
  assert.deepEqual(dimensaoAlvo(256, 256, 512), { largura: 256, altura: 256 });
  assert.deepEqual(dimensaoAlvo(512, 256, 512), { largura: 512, altura: 256 });
  assert.deepEqual(dimensaoAlvo(768, 256, 1024), { largura: 768, altura: 256 });
});

test('o teto e o alinhamento se aplicam nesta ordem', () => {
  // 768x256 com teto 500: fator 500/768, da 500x167, e o alinhamento corta
  // para 500x164. Alinhar antes do teto daria outro numero.
  assert.deepEqual(dimensaoAlvo(768, 256, 500), { largura: 500, altura: 164 });
});

test('MAX_TEXTURA vem vazio: o teto NAO se liga sozinho', () => {
  // O teto troca qualidade por tamanho, e a troca aparece de perto. Ligar por
  // padrao seria decidir no lugar do chefe. Ver docs/desempenho.md.
  assert.equal(Object.keys(MAX_TEXTURA).length, 0);
});
