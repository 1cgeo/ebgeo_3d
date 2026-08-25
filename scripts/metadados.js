#!/usr/bin/env node

/**
 * @module scripts/metadados
 * @description Traz para o catalogo os metadados que o `config.js` do ebgeo_web
 * ja carrega: descricao, local, palavras-chave e data de captura.
 *
 * POR QUE ISTO EXISTE. A importacao mede o que da para medir do proprio tileset
 * (ponto de navegacao, altura do chao, motor, contagem). O que ela NAO tem como
 * saber e o que uma pessoa escreveu: "Ponte sobre o rio Paraiba do Sul",
 * "Quatis, RJ", a data do voo. Esse texto existe, e esta no config de producao,
 * escrito modelo a modelo ao longo de anos. Digitar de novo seria jogar fora
 * trabalho feito, e cada redigitacao e uma chance de errar.
 *
 * O NOME TAMBEM VEM, e so enquanto o catalogo ainda mostra o slug. Sem `--nome`
 * na importacao o catalogo grava `name = id`, e e esse valor que o card exibe:
 * "14ciaecmb" no lugar de "14a Companhia de Engenharia de Combate". Nome que o
 * operador escolheu na importacao nao se sobrescreve.
 *
 * O QUE ELE NAO TRAZ: `url`, `heightOffset`, `locate` e
 * `maximumScreenSpaceError`. Os quatro sao MEDIDOS ou derivados pela
 * importacao, e o valor do config e justamente o que esta sendo aposentado. O
 * `heightOffset` do config antigo, em especial, e ajuste no olho de quem nao
 * tinha a medida.
 *
 * TRES CRITERIOS DE CASAMENTO, nesta ordem: ID, PASTA DA URL e NOME
 * normalizado. Os ids do config de producao seguem outra convencao
 * (`ponte-general-osorio` contra `ponte-quatis`, `18bimtz` contra `18bi`), e a
 * pasta e o que os dois lados sempre compartilham, porque o slug do catalogo
 * nasce dela pela regra do `lote.js`. Um casamento ambiguo NAO se aplica: ele
 * vai para a lista de duvidas, para o operador decidir.
 *
 * NENHUM dos tres dispensa o portao de lugar: par a mais de 5 km e outro
 * objeto, e vira duvida em vez de gravacao.
 *
 * Uso:
 *   node scripts/metadados.js --de <caminho do config.js>            # dry-run
 *   node scripts/metadados.js --de <caminho do config.js> --gravar
 *   node scripts/metadados.js --de <caminho> --gravar --id ponte-quatis
 */

import { readFileSync, existsSync } from 'node:fs';
import { getIndexDb, closeAll } from '../src/db/connection.js';
import { slugDaUrl } from './lib/slug.js';

function args() {
  const a = process.argv.slice(2);
  const v = (n, p) => { const i = a.indexOf(n); return i >= 0 && a[i + 1] ? a[i + 1] : p; };
  return {
    de: v('--de', ''),
    gravar: a.includes('--gravar'),
    somenteId: v('--id', ''),
  };
}

const o = args();
if (!o.de || !existsSync(o.de)) {
  console.error('ERRO: passe --de <caminho do config.js do ebgeo_web>.');
  process.exit(2);
}

/**
 * Extrai as entradas de `tilesets` do config.
 *
 * LEITURA POR REGEX, e nao por `import()` do arquivo. O config e um modulo do
 * Vite: ele usa `import.meta.env.DEV`, que fora do Vite nem existe, e traz
 * milhares de linhas de outras secoes. Avaliar o arquivo para colher texto
 * seria executar codigo de terceiro por conveniencia.
 *
 * O preco e conhecido: a regex so ve o que esta escrito literalmente, e ignora
 * valor montado por expressao. No config de producao os metadados sao literais.
 */
function leTilesets(caminho) {
  const texto = readFileSync(caminho, 'utf-8');
  const inicio = texto.indexOf('tilesets:');
  if (inicio < 0) return [];

  // Recorta o array equilibrando colchetes, a partir do primeiro `[`.
  const abre = texto.indexOf('[', inicio);
  let nivel = 0;
  let fim = -1;
  for (let i = abre; i < texto.length; i++) {
    if (texto[i] === '[') nivel++;
    else if (texto[i] === ']') { nivel--; if (nivel === 0) { fim = i; break; } }
  }
  if (fim < 0) return [];
  const bloco = texto.slice(abre + 1, fim);

  // Cada entrada e um objeto de primeiro nivel dentro do array.
  const entradas = [];
  let profundidade = 0;
  let comeco = -1;
  for (let i = 0; i < bloco.length; i++) {
    const c = bloco[i];
    if (c === '{') { if (profundidade === 0) comeco = i; profundidade++; }
    else if (c === '}') {
      profundidade--;
      if (profundidade === 0 && comeco >= 0) { entradas.push(bloco.slice(comeco, i + 1)); comeco = -1; }
    }
  }

  return entradas.map((e) => {
    const texto1 = (campo) => {
      const m = new RegExp(`\\b${campo}\\s*:\\s*(["'])((?:\\\\.|(?!\\1).)*)\\1`).exec(e);
      return m ? m[2] : null;
    };
    const lista = (campo) => {
      const m = new RegExp(`\\b${campo}\\s*:\\s*\\[([^\\]]*)\\]`).exec(e);
      if (!m) return null;
      const itens = [...m[1].matchAll(/(["'])((?:\\.|(?!\1).)*)\1/g)].map((x) => x[2]);
      return itens.length ? itens : null;
    };
    return {
      id: texto1('id'),
      name: texto1('name'),
      slugDaUrl: slugDaUrl(texto1('url')),
      description: texto1('description'),
      local: texto1('local'),
      data_captura: texto1('data_captura'),
      keywords: lista('keywords'),
      locate: (() => {
        const m = /\blocate\s*:\s*\{([^}]*)\}/.exec(e);
        if (!m) return null;
        const num = (c) => {
          const x = new RegExp(`\\b${c}\\s*:\\s*(-?[0-9.]+)`).exec(m[1]);
          return x ? Number(x[1]) : null;
        };
        const lon = num('lon'); const lat = num('lat');
        return (lon != null && lat != null) ? { lon, lat } : null;
      })(),
    };
  }).filter((x) => x.id);
}

/**
 * Distancia aproximada entre dois pontos, em metros.
 *
 * O PORTAO QUE ELA ALIMENTA EXISTE POR UM CASO REAL. O config de producao tem
 * uma "Ponte General Osorio" em Manoel Viana, RS, e o acervo tem outra em
 * Quatis, RJ: mesmo nome, 1.100 km de distancia, pontes diferentes. Casar por
 * nome sem conferir o lugar teria colado a descricao de uma na outra, e nada no
 * catalogo denunciaria.
 */
function distancia(a, b) {
  const grau = Math.PI / 180;
  const dx = (a.lon - b.lon) * 111320 * Math.cos(((a.lat + b.lat) / 2) * grau);
  const dy = (a.lat - b.lat) * 111320;
  return Math.hypot(dx, dy);
}

/** Acima disto o par nao se aplica: e outro objeto com o mesmo nome. */
const DISTANCIA_MAXIMA_M = 5000;

/** Normaliza para casar nome: sem acento, sem pontuacao, minusculo. */
function chaveDeNome(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const doConfig = leTilesets(o.de);
console.log(`config: ${doConfig.length} entradas com id`);

const db = getIndexDb();
const modelos = db.prepare(
  o.somenteId ? 'SELECT * FROM models WHERE id = ?' : 'SELECT * FROM models ORDER BY id',
).all(...(o.somenteId ? [o.somenteId] : []));
console.log(`catalogo: ${modelos.length} modelos\n`);

const porId = new Map(doConfig.map((x) => [x.id, x]));

/**
 * TERCEIRO CRITERIO DE CASAMENTO: a PASTA da url.
 *
 * POR QUE ELE EXISTE, e o caso e medido. O id do config de producao segue outra
 * convencao que a do acervo (`18bimtz` contra `18bi`, `1DE` contra `1de`,
 * `VBE_L_PNT_NOVA` contra `vbe_l_pnt_nova`), e o nome nem sempre salva. O que os
 * dois lados SEMPRE compartilham e a pasta: o slug do catalogo nasce do nome de
 * pasta pela regra do `lote.js`, e a url do config aponta essa mesma pasta.
 *
 * Sem ele, cinco modelos do acervo ficavam sem descricao, local, palavra-chave e
 * data, e o texto existia no config o tempo todo. Os cinco pares passam pelo
 * portao de distancia entre 33 e 140 m.
 *
 * Ele entra DEPOIS do id e ANTES do nome, e nao dispensa o portao de lugar: duas
 * pastas homonimas em cidades diferentes continuariam sendo objetos diferentes.
 */
const porSlugUrl = new Map();
for (const x of doConfig) {
  if (!x.slugDaUrl) continue;
  // Pasta repetida vira AMBIGUA, e ambigua nao se aplica.
  porSlugUrl.set(x.slugDaUrl, porSlugUrl.has(x.slugDaUrl) ? null : x);
}

const porNome = new Map();
for (const x of doConfig) {
  const k = chaveDeNome(x.name);
  if (!k) continue;
  // Nome repetido vira AMBIGUO, e ambiguo nao se aplica.
  porNome.set(k, porNome.has(k) ? null : x);
}

const atualiza = db.prepare(`
  UPDATE models SET
    name         = COALESCE(?, name),
    description  = COALESCE(?, description),
    local        = COALESCE(?, local),
    keywords     = COALESCE(?, keywords),
    captured_at  = COALESCE(?, captured_at)
  WHERE id = ?
`);

let aplicados = 0;
const semPar = [];
const duvidas = [];

for (const m of modelos) {
  let fonte = porId.get(m.id) || null;
  let como = 'id';
  if (!fonte && porSlugUrl.has(m.id)) {
    fonte = porSlugUrl.get(m.id);
    como = 'pasta da url';
    if (fonte === null) {
      duvidas.push(`${m.id}: mais de uma entrada do config aponta a pasta "${m.id}"`);
      continue;
    }
  }
  if (!fonte) {
    const k = chaveDeNome(m.name);
    if (porNome.has(k)) {
      fonte = porNome.get(k);
      como = 'nome';
      if (fonte === null) { duvidas.push(`${m.id}: nome "${m.name}" aparece mais de uma vez no config`); continue; }
    }
  }
  if (!fonte) { semPar.push(m.id); continue; }

  // PORTAO DE LUGAR. O par so vale se os dois estiverem no mesmo lugar.
  if (fonte.locate && m.lon != null && m.lat != null) {
    const d = distancia({ lon: m.lon, lat: m.lat }, fonte.locate);
    if (d > DISTANCIA_MAXIMA_M) {
      duvidas.push(`${m.id}: par "${fonte.id}" esta a ${(d / 1000).toFixed(0)} km daqui`
        + ` (${fonte.locate.lon.toFixed(4)}, ${fonte.locate.lat.toFixed(4)}).`
        + ' Mesmo nome, objeto diferente.');
      continue;
    }
  }

  const kw = fonte.keywords ? JSON.stringify(fonte.keywords) : null;

  // O NOME SO ENTRA ENQUANTO O CATALOGO AINDA MOSTRA O SLUG. Sem `--nome`, a
  // importacao grava `name = id`, e e esse valor que o card do catalogo exibe:
  // "14ciaecmb" no lugar de "14a Companhia de Engenharia de Combate". Um nome
  // que o operador escolheu na importacao NAO se sobrescreve por texto de
  // config, pela mesma razao que o `heightOffset` de la nao se copia.
  const nome = (m.name === m.id && fonte.name) ? fonte.name : null;
  const campos = [nome, fonte.description, fonte.local, kw, fonte.data_captura];
  if (campos.every((c) => c == null)) { semPar.push(`${m.id} (par ${fonte.id}, mas sem texto)`); continue; }

  console.log(`${m.id}  <-  ${fonte.id}  (por ${como})`);
  for (const [rotulo, valor] of [['nome', nome], ['descricao', fonte.description], ['local', fonte.local],
    ['keywords', kw], ['data', fonte.data_captura]]) {
    if (valor) console.log(`    ${rotulo}: ${String(valor).slice(0, 90)}`);
  }
  if (o.gravar) { atualiza.run(...campos, m.id); aplicados++; }
}

if (semPar.length) {
  console.log(`\nSEM PAR no config (${semPar.length}): ${semPar.join(', ')}`);
}
if (duvidas.length) {
  console.log(`\nAMBIGUOS, nao aplicados (${duvidas.length}):`);
  for (const d of duvidas) console.log(`  ${d}`);
}
console.log(o.gravar
  ? `\n${aplicados} modelos atualizados`
  : '\ndry-run: nada gravado (use --gravar)');
closeAll();
