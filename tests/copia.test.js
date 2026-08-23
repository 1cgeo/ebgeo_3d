/**
 * A copia do HD confere a propria extensao?
 *
 * O DEFEITO QUE ESTES TESTES GUARDAM. Em 2026-08-23 o `forte_santa_barbara`
 * converteu com 42.176 erros, e todos eram `ENOENT` na COPIA DE TRABALHO, nunca
 * na origem. A copia ja tinha retentativa por arquivo, e ainda assim entregou
 * arvore truncada: o `readdirSync` do HD externo devolve listagem curta SEM
 * LANCAR, entao a retentativa nunca dispara. Para ela, a copia deu certo.
 *
 * O primeiro teste e o que importa: ele REPROVA a arvore truncada. Sem ele, a
 * conferencia poderia devolver `null` sempre e todos os outros passariam.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  copiaArvore, copiaConferida, tamanho, divergencia, comparaComOrigem,
} from '../scripts/lib/copia.js';

/** Uma arvore com subpasta, como a do Metashape: raiz, `Data/`, tiles dentro. */
function arvoreDeMentira() {
  const raiz = mkdtempSync(join(tmpdir(), 'copia-'));
  const de = join(raiz, 'origem');
  mkdirSync(join(de, 'Data', 'e0303'), { recursive: true });
  writeFileSync(join(de, 'tileset.json'), '{"asset":{"version":"1.1"}}');
  for (let i = 0; i < 5; i++) {
    writeFileSync(join(de, 'Data', 'e0303', `f2275${i}.b3dm`), Buffer.alloc(100 + i));
  }
  return { raiz, de, para: join(raiz, 'destino') };
}

test('a arvore truncada e REPROVADA', () => {
  const { raiz, de, para } = arvoreDeMentira();
  try {
    copiaArvore(de, para);
    // O truncamento do HD, encenado: um tile que a copia nao trouxe.
    unlinkSync(join(para, 'Data', 'e0303', 'f22753.b3dm'));

    const motivo = divergencia(tamanho(para), tamanho(de));
    assert.ok(motivo, 'a conferencia aceitou uma arvore com um arquivo a menos');
    assert.match(motivo, /copiou 5 arquivos/);
    assert.match(motivo, /a origem tem 6/);
  } finally {
    rmSync(raiz, { recursive: true, force: true });
  }
});

test('a arvore inteira PASSA, com a contagem certa', () => {
  const { raiz, de, para } = arvoreDeMentira();
  try {
    const escrito = copiaConferida(de, para);
    assert.equal(escrito.arquivos, 6);
    assert.equal(escrito.bytes, tamanho(de).bytes);
    assert.equal(divergencia(escrito, tamanho(de)), null);
  } finally {
    rmSync(raiz, { recursive: true, force: true });
  }
});

test('a copia herdada de uma corrida morta nao sobrevive', () => {
  const { raiz, de, para } = arvoreDeMentira();
  try {
    // O que o `lote.js` encontrava no disco: sobra de um processo morto no meio.
    mkdirSync(join(para, 'Data', 'e0303'), { recursive: true });
    writeFileSync(join(para, 'lixo-de-corrida-morta.b3dm'), Buffer.alloc(9));

    const escrito = copiaConferida(de, para);
    assert.equal(escrito.arquivos, 6, 'a sobra entrou na conta');
    assert.equal(tamanho(para).arquivos, 6, 'a sobra ficou no destino');
  } finally {
    rmSync(raiz, { recursive: true, force: true });
  }
});

test('erro de leitura na origem reprova, mesmo com os numeros batendo', () => {
  const iguais = { arquivos: 10, bytes: 500 };
  assert.equal(divergencia(iguais, { ...iguais, erros: 0 }), null);
  assert.match(divergencia(iguais, { ...iguais, erros: 1 }), /erro\(s\) de leitura/);
});

test('byte a mais com a mesma contagem de arquivos reprova', () => {
  const motivo = divergencia({ arquivos: 6, bytes: 999 }, { arquivos: 6, bytes: 1000, erros: 0 });
  assert.ok(motivo, 'so a contagem de arquivos foi conferida, os bytes nao');
});

/**
 * A regra de tres numeros de `comparaComOrigem`.
 *
 * O RISCO QUE ESTES TESTES GUARDAM. A regra existe para nao punir fidelidade: o
 * conversor copia a PASTA, e a pasta tem tiles que a raiz nao alcanca. Afrouxar
 * para acomodar isso e perigoso, e o primeiro teste e o que impede a cura de
 * virar doenca. Produto com tile FALTANDO reprova em qualquer circunstancia.
 */

test('produto com tile faltando REPROVA, mesmo com a origem tropecando', () => {
  const v = comparaComOrigem(900, { tiles: 1000, total: 1200, erros: 3 });
  assert.ok(v.problema, 'a origem tropecar virou desculpa para faltar tile');
  assert.match(v.problema, /faltam 100/);
  assert.equal(v.fato, undefined);
});

test('produto e origem iguais nao dizem nada', () => {
  assert.deepEqual(comparaComOrigem(1000, { tiles: 1000, total: 1000, erros: 0 }), {});
  assert.deepEqual(comparaComOrigem(1000, { tiles: 1000, total: 5000, erros: 5 }), {});
});

test('tile orfao NA ORIGEM vira fato, e nao reprovacao', () => {
  // O caso real do `14ciaecmb`: 1.942 tiles em tres ramos que nenhum tileset
  // referencia. O conversor copiou a pasta, e ser fiel nao pode reprovar.
  const v = comparaComOrigem(10074, { tiles: 8132, total: 10074, erros: 0 });
  assert.equal(v.problema, undefined, 'reprovou um produto fiel a origem');
  assert.match(v.fato, /1942 tile/);
});

test('produto maior com origem ILEGIVEL vira fato, e nao reprovacao', () => {
  // O caso real do `estrela-merge`: o indice de um ramo esta com 0 byte, e os
  // 747 tiles dele somem da travessia.
  const v = comparaComOrigem(152787, { tiles: 152040, total: 246821, erros: 1 });
  assert.equal(v.problema, undefined);
  assert.match(v.fato, /747 tile/);
});

test('produto acima do TOTAL da origem continua REPROVANDO', () => {
  // Nao ha origem para esses tiles. Isso e defeito, e nenhuma folga o cobre.
  const v = comparaComOrigem(1300, { tiles: 1000, total: 1200, erros: 0 });
  assert.ok(v.problema, 'tile sem origem nenhuma passou');
  assert.match(v.problema, /so tem 1200/);
});

test('produto acima do total NAO se safa com erro de leitura', () => {
  const v = comparaComOrigem(1300, { tiles: 1000, total: 1200, erros: 9 });
  assert.ok(v.fato || v.problema, 'ficou em silencio');
});
