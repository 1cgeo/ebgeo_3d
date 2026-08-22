/**
 * @module scripts/lib/deposito
 * @description A troca do arquivo publicado, compartilhada pelos dois
 * importadores.
 *
 * ESTA FUNCAO NAO SE DUPLICA. Ela carrega a armadilha do Windows: com o servico
 * no ar, o `rename` por cima do `.3dtiles` publicado falha com EBUSY, porque o
 * `closeModelDb` so fecha a conexao do PROPRIO processo e o servico e outro. A
 * saida e preservar o `.parcial` e mandar promover depois. Uma segunda copia
 * disso e uma segunda chance de esquecer o caso, e o sintoma seria uma corrida
 * de horas jogada fora.
 */

import { existsSync, unlinkSync, renameSync, statSync } from 'node:fs';
import { closeModelDb, closeAll } from '../../src/db/connection.js';
import { closeImport } from '../../src/db/queries.js';

/**
 * Troca o arquivo publicado pelo `.parcial` recem-convertido.
 *
 * Em caso de bloqueio no Windows, fecha a importacao como falha, deixa o
 * `.parcial` no lugar e SAI com codigo 6, apontando o `--promover`.
 *
 * @param {object} ctx
 * @param {string} ctx.temporario
 * @param {string} ctx.destino
 * @param {string} ctx.dbFilename
 * @param {number} ctx.importId
 * @param {object} ctx.conv - totais da conversao, para o registro de falha
 * @param {(s:string)=>void} ctx.log
 * @param {string} [ctx.roteiro] - qual roteiro sugerir no --promover
 * @returns {number} bytes do arquivo publicado
 */
export function trocaArquivo({ temporario, destino, dbFilename, importId, conv, log, roteiro = 'scripts/importar.js' }) {
  closeModelDb(dbFilename);
  try {
    for (const f of [destino, `${destino}-wal`, `${destino}-shm`]) {
      if (existsSync(f)) unlinkSync(f);
    }
    renameSync(temporario, destino);
  } catch (err) {
    if (!['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) throw err;
    console.error(`\n=== PARADO no passo 6: o arquivo publicado esta em uso (${err.code}) ===`);
    console.error('A conversao terminou e passou na conferencia. Nada se perdeu.');
    console.error('No Windows o servico no ar segura o arquivo, e ele e outro processo.');
    console.error('\nPare o servico e rode:');
    console.error(`  node ${roteiro} --promover --id ${dbFilename.replace(/\.3dtiles$/, '')}`);
    closeImport({
      id: importId,
      finished_at: new Date().toISOString(),
      status: 'falhou',
      tiles_in: conv.tentados,
      tiles_out: conv.convertidos,
      textures: conv.texturas,
      failures: conv.falhasTextura,
      seconds: conv.segundos,
      ratio: null,
      notes: `troca do arquivo bloqueada (${err.code}); .parcial pronto para --promover`,
    });
    closeAll();
    process.exit(6);
  }
  log(`  ${dbFilename} publicado`);
  return statSync(destino).size;
}
