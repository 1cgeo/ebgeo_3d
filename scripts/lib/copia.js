/**
 * @module scripts/lib/copia
 * @description Copiar do HD externo para o PC, e CONFERIR que a copia inteira chegou.
 *
 * Este modulo existe separado do `lote.js` por uma razao so: a conferencia
 * precisa de teste, e o `lote.js` converte o acervo assim que e importado.
 */

import {
  existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';

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
export function tentando(o_que, quantas = 3) {
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
export function tamanho(raiz) {
  let bytes = 0;
  let erros = 0;
  let arquivos = 0;
  (function anda(dir) {
    let entradas;
    try { entradas = readdirSync(dir, { withFileTypes: true }); } catch { erros++; return; }
    for (const e of entradas) {
      const p = join(dir, e.name);
      try {
        if (e.isDirectory()) anda(p);
        else { bytes += statSync(p).size; arquivos += 1; }
      } catch { erros++; }
    }
  })(raiz);
  return { bytes, erros, arquivos };
}

/** Copia uma arvore inteira, e devolve quantos arquivos e bytes escreveu. */
export function copiaArvore(de, para) {
  mkdirSync(para, { recursive: true });
  let arquivos = 0;
  let bytes = 0;
  for (const e of tentando(() => readdirSync(de, { withFileTypes: true }))) {
    const origem = join(de, e.name);
    const alvo = join(para, e.name);
    if (e.isDirectory()) {
      const sub = copiaArvore(origem, alvo);
      arquivos += sub.arquivos;
      bytes += sub.bytes;
    } else {
      tentando(() => copyFileSync(origem, alvo));
      arquivos += 1;
      bytes += tentando(() => statSync(alvo).size);
    }
  }
  return { arquivos, bytes };
}

/**
 * Copia e CONFERE, com a conferencia cobrindo a mesma extensao da escrita.
 *
 * POR QUE CONFERIR. A copia ja tinha retentativa por arquivo, e ainda assim
 * entregou arvore truncada: em 2026-08-23 o `forte_santa_barbara` converteu com
 * 42.176 erros, todos `ENOENT` na COPIA DE TRABALHO, nunca na origem. O
 * `readdirSync` do HD externo devolve listagem curta SEM LANCAR quando o disco
 * engasga, entao a retentativa nao dispara: para ela, a copia deu certo.
 *
 * A conferencia le a origem de novo, DEPOIS da copia, e compara arquivo a
 * arquivo e byte a byte. Duas leituras independentes que discordam denunciam o
 * truncamento; uma leitura so nunca denunciaria, porque a copia conta o que ela
 * mesma viu. Custa um segundo `scandir` da origem, minutos numa corrida de
 * horas, e o que ele evita e uma conversao inteira contra dado que nao existe.
 *
 * A tolerancia e ZERO. Nao ha caso legitimo em que copiar uma arvore produza
 * numero diferente, e afrouxar aqui deixaria passar exatamente o defeito que a
 * conferencia existe para pegar.
 */
export function divergencia(escrito, fonte) {
  if (fonte.erros > 0) {
    return `a origem devolveu ${fonte.erros} erro(s) de leitura na conferencia`;
  }
  if (escrito.arquivos !== fonte.arquivos || escrito.bytes !== fonte.bytes) {
    return `copiou ${escrito.arquivos} arquivos e ${escrito.bytes} bytes,`
      + ` a origem tem ${fonte.arquivos} e ${fonte.bytes}`;
  }
  return null;
}

export function copiaConferida(de, para, tentativas = 2) {
  let ultimo = '';
  for (let i = 1; i <= tentativas; i++) {
    if (existsSync(para)) rmSync(para, { recursive: true, force: true });
    const escrito = copiaArvore(de, para);
    ultimo = divergencia(escrito, tamanho(de));
    if (!ultimo) return escrito;
    if (i < tentativas) console.log(`  copia divergiu (${ultimo}); refazendo do zero...`);
  }
  throw new Error(`copia do HD nao confere depois de ${tentativas} tentativas: ${ultimo}`);
}
