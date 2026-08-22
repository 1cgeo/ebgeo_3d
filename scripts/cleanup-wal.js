#!/usr/bin/env node

/**
 * @module scripts/cleanup-wal
 * @description Tira os bancos do WAL e apaga as sobras.
 *
 * POR QUE ISSO IMPORTA. Em `journal_mode = wal` o SQLite precisa criar o arquivo
 * `-shm` ao abrir, mesmo para ler. Num volume montado `:ro` isso falha, e o
 * servico morre com uma mensagem que nao aponta a causa. A DGEO ja pagou esse
 * defeito na publicacao do terreno.
 *
 * Fora do WAL o modelo vira arquivo unico, que e o que se copia para producao.
 *
 * O index.db fica em WAL de proposito: ele recebe escrita a cada importacao e
 * mora do lado de ca. Este roteiro so faz o checkpoint dele.
 */

import { readdirSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import config from '../src/config.js';

const seco = process.argv.includes('--dry-run');

function trata(caminho, alvo) {
  const antes = statSync(caminho).size;
  const db = new Database(caminho);
  const modo = db.pragma('journal_mode', { simple: true });
  if (modo === alvo) {
    db.close();
    return { modo, mudou: false, antes };
  }
  if (!seco) {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.pragma(`journal_mode = ${alvo}`);
  }
  const novo = db.pragma('journal_mode', { simple: true });
  db.close();
  for (const suf of ['-wal', '-shm']) {
    const s = caminho + suf;
    if (existsSync(s) && !seco) unlinkSync(s);
  }
  return { modo, novo, mudou: true, antes };
}

console.log(seco ? 'dry-run: nada sera escrito\n' : '');

if (existsSync(config.indexDbPath)) {
  const db = new Database(config.indexDbPath);
  if (!seco) db.pragma('wal_checkpoint(TRUNCATE)');
  console.log(`index.db  journal=${db.pragma('journal_mode', { simple: true })}  checkpoint feito`);
  db.close();
}

if (!existsSync(config.modelsDbDir)) {
  console.log('sem diretorio de modelos.');
  process.exit(0);
}

let mexidos = 0;
for (const nome of readdirSync(config.modelsDbDir)) {
  if (!nome.endsWith('.3dtiles')) continue;
  const caminho = join(config.modelsDbDir, nome);
  const r = trata(caminho, 'delete');
  const marca = r.mudou ? `${r.modo} -> ${r.novo || 'delete'}` : `${r.modo} (ja estava)`;
  console.log(`${nome.padEnd(34)} ${marca}`);
  if (r.mudou) mexidos++;
}
console.log(`\n${mexidos} bancos tirados do WAL.`);
