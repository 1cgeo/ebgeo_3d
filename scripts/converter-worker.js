/**
 * @module scripts/converter-worker
 * @description Worker de conversao. Recebe caminhos de tile, devolve o glb.
 *
 * A UNIDADE DE PARALELISMO E O TILE, e nao a operacao dentro dele. Deixar o
 * sharp e o `ktx` usarem as proprias threads DENTRO de um tile e depois rodar um
 * tile por vez daria o mesmo trabalho com pior aproveitamento: medido, doze
 * workers levam 9,08 tiles/s nos tiles pesados do DJI Terra e 30,8 nos do
 * Metashape, contra 1,68 e 5,15 com um worker so.
 *
 * O BUFFER VOLTA POR TRANSFERENCIA, nao por copia. Um tile do DJI Terra tem
 * 271 KiB, e copiar isso a cada mensagem em milhoes de tiles seria trabalho
 * puro. `postMessage` com transferList entrega a memoria e a invalida aqui.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { criarConversor } from './lib/conversor.js';

const { qlevel, geometria, upAxis } = workerData;
const conversor = await criarConversor({ geometria, upAxis });

parentPort.on('message', async (msg) => {
  if (msg.fim) {
    conversor.fecha();
    parentPort.close();
    return;
  }

  const { chave, caminho } = msg;
  try {
    const bruto = await readFile(caminho);
    const r = await conversor.converte(bruto, qlevel);
    // O Buffer do Node compartilha um ArrayBuffer de pool; `transfer` precisa do
    // ArrayBuffer inteiro e exclusivo. Uma copia para um ArrayBuffer proprio sai
    // mais barata que a serializacao estrutural padrao, que copiaria de todo
    // jeito e ainda pagaria o clone do envelope.
    const ab = r.glb.buffer.slice(r.glb.byteOffset, r.glb.byteOffset + r.glb.byteLength);
    parentPort.postMessage({
      chave,
      ok: true,
      bytesEntrada: bruto.length,
      texturas: r.texturas,
      falhasTextura: r.falhas,
      triangulos: r.triangulos,
      batchTableDescartada: r.batchTableDescartada,
      gerador: r.gerador,
      glb: ab,
    }, [ab]);
  } catch (err) {
    parentPort.postMessage({ chave, ok: false, erro: err.message });
  }
});

parentPort.postMessage({ pronto: true });
