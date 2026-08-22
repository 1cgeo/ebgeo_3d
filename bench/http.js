#!/usr/bin/env node

/**
 * @module bench/http
 * @description Bancada de carga do serviço, pela porta HTTP.
 *
 * Mede o que o cliente sente: requisicoes por segundo, latencia por percentil, e
 * o efeito de cada caminho do codigo (200, 304, travessia contra sorteio).
 *
 * O SERVICO TEM DE ESTAR NO AR, e com o modelo importado. A bancada nao sobe o
 * servidor de proposito: medir um processo que ela mesma criou esconderia o
 * efeito das variaveis de ambiente que a producao usa.
 *
 * Uso:
 *   node bench/http.js --modelo ponte-quatis
 *   node bench/http.js --modelo ponte-quatis --requisicoes 5000 --json saida.json
 */

import { writeFileSync } from 'node:fs';
import { travessia, sorteio, repete } from './lib/alvos.js';
import { dispara, aquece, linha, CABECALHO } from './lib/carga.js';

function args() {
  const a = process.argv.slice(2);
  const v = (n, p) => { const i = a.indexOf(n); return i >= 0 && a[i + 1] ? a[i + 1] : p; };
  return {
    base: v('--base', 'http://127.0.0.1:8082'),
    modelo: v('--modelo', 'ponte-quatis'),
    requisicoes: parseInt(v('--requisicoes', '4000'), 10),
    concorrencias: v('--concorrencia', '1,4,16,64,128').split(',').map(Number),
    json: v('--json'),
  };
}

const o = args();
const raiz = `${o.base}/api/v1/models/${o.modelo}`;

console.log(`alvo      ${raiz}`);
const saude = await fetch(`${o.base}/health`).then((r) => r.json()).catch(() => null);
if (!saude || saude.status !== 'ok') {
  console.error('ERRO: o servico nao responde em /health. Suba com `npm start`.');
  process.exit(2);
}
console.log(`servico   ${saude.models} modelos, ${saude.tiles.toLocaleString('pt-BR')} tiles, conexoes ${saude.connections.open}/${saude.connections.limit}`);

console.log('\ncoletando a arvore de tiles...');
const { tiles, jsons } = await travessia(raiz);
if (!tiles.length) {
  console.error('ERRO: nenhum tile coletado. O modelo existe e esta publicado?');
  process.exit(3);
}
console.log(`  ${tiles.length.toLocaleString('pt-BR')} tiles, ${jsons.length} tilesets`);

console.log('\naquecendo...');
await aquece(tiles);

const resultados = {};
const registra = async (rotulo, alvos, concorrencia, cabecalhos) => {
  const r = await dispara(alvos, { concorrencia, cabecalhos });
  resultados[rotulo] = { ...r, concorrencia };
  console.log(linha(rotulo, r));
  return r;
};

// ---------------------------------------------------------------- cenarios

console.log('\n=== 1. tile, travessia (o padrao do Cesium) ===');
console.log(CABECALHO);
const emOrdem = repete(tiles, o.requisicoes);
for (const c of o.concorrencias) {
  await registra(`travessia c=${c}`, emOrdem, c);
}

console.log('\n=== 2. tile, sorteado (o piso: pior caso do cache) ===');
console.log(CABECALHO);
const aleatorio = repete(sorteio(tiles), o.requisicoes);
for (const c of o.concorrencias) {
  await registra(`sorteio c=${c}`, aleatorio, c);
}

console.log('\n=== 3. o caminho do 304 ===');
console.log(CABECALHO);
// Pega o ETag de um tile e devolve o MESMO em todas as requisicoes. Nao e o
// cenario real (cada tile tem seu ETag), e sim a medida do CUSTO do caminho:
// com um ETag que nao bate, o servico le o BLOB; com um que bate, nao le.
const primeiro = await fetch(tiles[0].caminho);
const etag = primeiro.headers.get('etag');
await registra('304 (etag bate)', repete([tiles[0]], o.requisicoes), 64, { 'if-none-match': etag });
await registra('200 (mesmo tile)', repete([tiles[0]], o.requisicoes), 64);

console.log('\n=== 4. metadado ===');
console.log(CABECALHO);
await registra('tileset.json', repete(jsons, Math.min(o.requisicoes, 2000)), 16);
await registra('catalogo', repete([{ caminho: `${o.base}/api/v1/models` }], 2000), 16);
await registra('health', repete([{ caminho: `${o.base}/health` }], 2000), 16);

console.log('\n=== 5. resposta de erro ===');
console.log(CABECALHO);
await registra('404 (chave inexistente)', repete([{ caminho: `${raiz}/Data/naotem.glb` }], 2000), 16);

// ---------------------------------------------------------------- resumo

const melhor = Object.entries(resultados)
  .filter(([k]) => k.startsWith('travessia'))
  .sort((a, b) => b[1].rps - a[1].rps)[0];

console.log('\n=== resumo ===');
console.log(`pico de tile     ${melhor[1].rps.toLocaleString('pt-BR')} req/s com ${melhor[1].concorrencia} em voo (${melhor[1].mbps} MiB/s)`);
console.log(`p99 nesse ponto  ${melhor[1].latencia.p99} ms`);
const c304 = resultados['304 (etag bate)'];
const c200 = resultados['200 (mesmo tile)'];
if (c304 && c200) {
  console.log(`304 contra 200   ${(c304.rps / c200.rps).toFixed(2)}x mais requisicoes por segundo`);
}
const depois = await fetch(`${o.base}/health`).then((r) => r.json());
console.log(`conexoes no fim  ${depois.connections.open}/${depois.connections.limit}`);

if (o.json) {
  writeFileSync(o.json, JSON.stringify({ modelo: o.modelo, tiles: tiles.length, resultados }, null, 2));
  console.log(`\ngravado em ${o.json}`);
}
