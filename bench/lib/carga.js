/**
 * @module bench/lib/carga
 * @description Gerador de carga HTTP com concorrencia fixa, e a estatistica.
 *
 * SEM DEPENDENCIA EXTERNA, com `node:http` e um Agent de keep-alive. O
 * `autocannon` faria isto, mas ele martela UMA url; aqui a lista de alvos e o
 * ponto do exercicio, porque o padrao de acesso do Cesium e o que decide se o
 * cache de pagina do SQLite ajuda ou atrapalha.
 *
 * KEEP-ALIVE LIGADO de proposito. Em producao o servico fica atras de um proxy
 * com HTTP/2 e conexao reaproveitada; medir com conexao nova por requisicao
 * mediria o handshake do TCP, que nao e nosso.
 */

import http from 'node:http';
import { performance } from 'node:perf_hooks';

/**
 * @typedef {object} Resultado
 * @property {number} requisicoes
 * @property {number} segundos
 * @property {number} rps
 * @property {number} bytes
 * @property {number} mbps
 * @property {object} latencia  - media, p50, p90, p99, max, em ms
 * @property {object} codigos   - contagem por status
 * @property {number} erros
 */

/**
 * Dispara `alvos.length` requisicoes com `concorrencia` em voo.
 *
 * @param {Array<{caminho:string}>} alvos
 * @param {object} opcoes
 * @param {number} opcoes.concorrencia
 * @param {Record<string,string>} [opcoes.cabecalhos]
 * @param {(feitas:number, total:number)=>void} [opcoes.progresso]
 * @returns {Promise<Resultado>}
 */
export function dispara(alvos, { concorrencia, cabecalhos = {}, progresso } = {}) {
  return new Promise((resolve) => {
    const agent = new http.Agent({
      keepAlive: true,
      maxSockets: concorrencia,
      maxFreeSockets: concorrencia,
    });

    const latencias = new Float64Array(alvos.length);
    const codigos = Object.create(null);
    let proximo = 0;
    let feitas = 0;
    let bytes = 0;
    let erros = 0;
    const t0 = performance.now();
    let ultimoAviso = t0;

    const encerra = () => {
      const segundos = (performance.now() - t0) / 1000;
      agent.destroy();
      const ordenadas = Array.from(latencias.subarray(0, feitas)).sort((a, b) => a - b);
      const pct = (p) => (ordenadas.length ? ordenadas[Math.min(ordenadas.length - 1, Math.floor(ordenadas.length * p))] : 0);
      const soma = ordenadas.reduce((a, b) => a + b, 0);
      resolve({
        requisicoes: feitas,
        segundos: +segundos.toFixed(3),
        rps: +(feitas / segundos).toFixed(1),
        bytes,
        mbps: +(bytes / 1048576 / segundos).toFixed(1),
        latencia: {
          media: +(soma / (ordenadas.length || 1)).toFixed(2),
          p50: +pct(0.5).toFixed(2),
          p90: +pct(0.9).toFixed(2),
          p99: +pct(0.99).toFixed(2),
          max: +(ordenadas[ordenadas.length - 1] || 0).toFixed(2),
        },
        codigos,
        erros,
      });
    };

    const puxa = () => {
      if (proximo >= alvos.length) {
        if (feitas >= alvos.length) encerra();
        return;
      }
      const i = proximo++;
      const url = new URL(alvos[i].caminho);
      const inicio = performance.now();

      const req = http.request({
        agent,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'GET',
        headers: cabecalhos,
      }, (res) => {
        codigos[res.statusCode] = (codigos[res.statusCode] || 0) + 1;
        let n = 0;
        res.on('data', (c) => { n += c.length; });
        res.on('end', () => {
          latencias[feitas] = performance.now() - inicio;
          bytes += n;
          feitas++;
          if (progresso && performance.now() - ultimoAviso > 2000) {
            ultimoAviso = performance.now();
            progresso(feitas, alvos.length);
          }
          if (feitas >= alvos.length) encerra();
          else puxa();
        });
      });
      req.on('error', () => {
        erros++;
        feitas++;
        if (feitas >= alvos.length) encerra();
        else puxa();
      });
      req.end();
    };

    if (!alvos.length) { encerra(); return; }
    for (let i = 0; i < Math.min(concorrencia, alvos.length); i++) puxa();
  });
}

/**
 * Aquece o servico e o cache de pagina antes de medir.
 *
 * SEM ISTO A PRIMEIRA MEDIDA MENTE. A primeira leitura de cada pagina do SQLite
 * paga o disco, e o LRU de conexoes esta vazio: a rodada inicial mede a abertura
 * do banco, nao o regime.
 *
 * @param {Array<{caminho:string}>} alvos @param {number} [quantos]
 */
export async function aquece(alvos, quantos = 300) {
  await dispara(alvos.slice(0, Math.min(quantos, alvos.length)), { concorrencia: 8 });
}

/** Formata um resultado numa linha de tabela. */
export function linha(rotulo, r) {
  const cods = Object.entries(r.codigos).map(([k, v]) => `${k}:${v}`).join(' ');
  return `${rotulo.padEnd(26)} ${String(r.rps).padStart(9)} ${String(r.mbps).padStart(8)} `
    + `${String(r.latencia.p50).padStart(8)} ${String(r.latencia.p90).padStart(8)} `
    + `${String(r.latencia.p99).padStart(8)} ${String(r.latencia.max).padStart(9)}  ${cods}`;
}

/** Cabecalho da tabela de resultados. */
export const CABECALHO = `${'cenario'.padEnd(26)} ${'req/s'.padStart(9)} ${'MiB/s'.padStart(8)} `
  + `${'p50 ms'.padStart(8)} ${'p90 ms'.padStart(8)} ${'p99 ms'.padStart(8)} ${'max ms'.padStart(9)}  codigos`;
