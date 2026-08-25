/**
 * A regra de slug e a mesma dos dois lados?
 *
 * O DEFEITO QUE ESTES TESTES GUARDAM. Ate 2026-08-25 o `metadados.js` casava o
 * config de producao com o catalogo so por ID e por NOME. Os ids do config
 * seguem outra convencao (`18bimtz`, `1DE`, `VBE_L_PNT_NOVA`), e cinco modelos
 * do acervo ficaram sem descricao, local, palavra-chave e data. O texto existia
 * no config o tempo todo, e nada no catalogo denunciava a falta.
 *
 * A ponte entre os dois lados e a PASTA: o `lote.js` batiza cada modelo com o
 * slug do nome de pasta, e a url do config aponta essa mesma pasta. Enquanto a
 * regra era uma copia em cada arquivo, nada impedia que divergissem, e nenhum
 * teste pegaria.
 *
 * O primeiro teste e o que importa: ele REPROVA a volta do casamento por id
 * puro, porque `1DE` e `1de` sao strings diferentes e so a regra os une.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { paraSlug, slugDaUrl } from '../scripts/lib/slug.js';

/**
 * Os cinco pares que o acervo perdeu, medidos em 2026-08-25.
 * A esquerda o que o config publica, a direita o id do catalogo.
 */
const OS_CINCO = [
  ['/catalogo/modelos_catalogo/3d/18bi/tileset.json', '18bi'],
  ['/catalogo/modelos_catalogo/3d/19bi/tileset.json', '19bi'],
  ['/catalogo/modelos_catalogo/3d/29gac/tileset.json', '29gac'],
  ['/catalogo/modelos_catalogo/3d/1DE/tileset.json', '1de'],
  ['/catalogo/modelos_catalogo/3d/VBE_L_PNT_NOVA/tileset.json', 'vbe_l_pnt_nova'],
];

test('a url do config leva ao id do catalogo nos cinco que se perderam', () => {
  for (const [url, esperado] of OS_CINCO) {
    assert.equal(slugDaUrl(url), esperado, `${url} devia dar ${esperado}`);
  }
});

test('a url que termina na pasta, e nao no arquivo, tambem serve', () => {
  assert.equal(slugDaUrl('/catalogo/modelos_catalogo/3d/1DE'), '1de');
  assert.equal(slugDaUrl('/catalogo/modelos_catalogo/3d/1DE/'), '1de');
});

test('o glb tem pasta como qualquer outro', () => {
  assert.equal(slugDaUrl('/catalogo/modelos_catalogo/3d/auditorio_aman/TGL.glb'), 'auditorio_aman');
});

test('url vazia ou sem pasta nao inventa slug', () => {
  for (const nada of [null, undefined, '', '/', 'tileset.json']) {
    assert.equal(slugDaUrl(nada), null, `${JSON.stringify(nada)} devia dar null`);
  }
});

test('paraSlug preserva sublinhado e hifen, e corta o resto', () => {
  assert.equal(paraSlug('VBE_L_PNT_NOVA'), 'vbe_l_pnt_nova');
  assert.equal(paraSlug('ponte-general-osorio'), 'ponte-general-osorio');
  assert.equal(paraSlug('Ponte Quatis'), 'ponte-quatis');
  assert.equal(paraSlug('--1DE--'), '1de');
  assert.equal(paraSlug('...'), '');
});

/**
 * O TESTE QUE GUARDA A DIVERGENCIA.
 *
 * O `lote.js` batiza o modelo e o `metadados.js` o reconhece. Se um dia alguem
 * reescrever a regra num dos dois, o casamento por pasta passa a errar em
 * silencio. Aqui a fonte do `lote.js` e lida e cobrada: o `paraId` dele tem de
 * continuar sendo o `paraSlug` do modulo, e nao uma copia.
 */
test('o lote.js usa o modulo, e nao uma copia da regra', () => {
  const fonte = readFileSync(new URL('../scripts/lote.js', import.meta.url), 'utf-8');
  assert.match(fonte, /from '\.\/lib\/slug\.js'/, 'o lote.js devia importar lib/slug.js');
  assert.match(fonte, /const paraId = paraSlug;/, 'o paraId devia delegar, nunca reimplementar');
  assert.doesNotMatch(fonte, /function paraId\s*\(/, 'reimplementar paraId traz a divergencia de volta');
});
