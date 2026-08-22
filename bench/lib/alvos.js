/**
 * @module bench/lib/alvos
 * @description Monta listas de URL para a carga, a partir do tileset de verdade.
 *
 * POR QUE NAO SORTEAR CHAVE DO BANCO. O CesiumJS nao pede tile aleatorio: ele
 * desce a arvore a partir da raiz e pede a VIZINHANCA do que a camera enxerga.
 * Uma carga de chaves sorteadas mede o pior caso do cache de pagina do SQLite, e
 * nao o caso real, entao ela subestima o serviço e leva a otimizar o que nao
 * dói. As duas formas estao aqui, e a bancada roda as duas: `travessia` e o
 * padrao realista, `sorteio` e o piso.
 */

/**
 * @typedef {object} Alvo
 * @property {string} caminho - Caminho da URL, ja com o token
 * @property {number} nivel   - Profundidade na arvore, 0 e a raiz
 */

/**
 * Baixa o tileset de raiz e todos os tilesets externos, e devolve os tiles em
 * ORDEM DE TRAVESSIA (largura primeiro), que é como o Cesium os descobre.
 *
 * @param {string} base - Ex.: 'http://127.0.0.1:8082/api/v1/models/ponte-quatis'
 * @param {object} [opcoes]
 * @param {number} [opcoes.maxTiles] - Para de coletar depois de N tiles
 * @returns {Promise<{tiles: Alvo[], jsons: Alvo[]}>}
 */
export async function travessia(base, { maxTiles = 20000 } = {}) {
  const tiles = [];
  const jsons = [];
  const vistos = new Set();

  // Fila de (caminho do tileset, prefixo do diretorio, nivel).
  const fila = [{ uri: 'tileset.json', dir: '', nivel: 0 }];

  while (fila.length && tiles.length < maxTiles) {
    const atual = fila.shift();
    const chave = junta(atual.dir, atual.uri);
    if (vistos.has(chave)) continue;
    vistos.add(chave);

    const resp = await fetch(`${base}/${chave}`);
    if (!resp.ok) continue;
    jsons.push({ caminho: `${base}/${chave}`, nivel: atual.nivel });
    const doc = await resp.json();

    const dirAtual = chave.includes('/') ? chave.slice(0, chave.lastIndexOf('/')) : '';

    const visita = (tile, nivel) => {
      if (!tile || typeof tile !== 'object') return;
      const conteudos = [];
      if (tile.content) conteudos.push(tile.content);
      if (Array.isArray(tile.contents)) conteudos.push(...tile.contents);

      for (const c of conteudos) {
        if (!c || typeof c.uri !== 'string') continue;
        const semQuery = c.uri.split('?')[0];
        if (semQuery.toLowerCase().endsWith('.json')) {
          // Tileset externo: entra na fila para ser baixado tambem.
          fila.push({ uri: c.uri, dir: dirAtual, nivel: nivel + 1 });
        } else if (tiles.length < maxTiles) {
          tiles.push({ caminho: `${base}/${junta(dirAtual, c.uri)}`, nivel });
        }
      }
      if (Array.isArray(tile.children)) {
        for (const f of tile.children) visita(f, nivel + 1);
      }
    };
    visita(doc.root, atual.nivel);
  }

  return { tiles, jsons };
}

/** Junta prefixo de diretorio e uri relativa, resolvendo "..". */
function junta(dir, uri) {
  const partes = [];
  for (const p of `${dir ? `${dir}/` : ''}${uri}`.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') { partes.pop(); continue; }
    partes.push(p);
  }
  return partes.join('/');
}

/**
 * Embaralha a lista de forma determinista, para a carga de pior caso.
 *
 * Semente fixa de proposito: duas execucoes da bancada tem de pedir os MESMOS
 * tiles na MESMA ordem, senao a comparacao entre configuracoes mede o sorteio.
 *
 * @param {Alvo[]} lista
 * @param {number} [semente]
 * @returns {Alvo[]}
 */
export function sorteio(lista, semente = 12345) {
  const copia = [...lista];
  let s = semente;
  const proximo = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(proximo() * (i + 1));
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia;
}

/**
 * Repete a lista ate atingir `total` itens, preservando a ordem.
 * @param {Alvo[]} lista @param {number} total @returns {Alvo[]}
 */
export function repete(lista, total) {
  if (!lista.length) return [];
  const saida = [];
  while (saida.length < total) {
    saida.push(...lista.slice(0, Math.min(lista.length, total - saida.length)));
  }
  return saida;
}
