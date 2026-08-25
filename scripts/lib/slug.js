/**
 * @module scripts/lib/slug
 * @description A regra unica que transforma nome de pasta do acervo em id de
 * catalogo, e a pasta que uma url do config aponta.
 *
 * POR QUE ISTO E UM MODULO, e nao duas copias. O `lote.js` usa a regra para
 * BATIZAR cada modelo na conversao, e o `metadados.js` usa a mesma regra para
 * RECONHECER esse modelo a partir da url do config de producao. As duas tem de
 * concordar sempre: se divergirem, o casamento por pasta erra em silencio, que
 * e o pior modo de errar, porque nada no catalogo denuncia.
 *
 * Enquanto eram duas funcoes iguais em arquivos diferentes, nada impedia a
 * divergencia, e nenhum teste a pegaria.
 */

/**
 * Transforma um nome de pasta do acervo no slug do catalogo.
 *
 * Minusculas; tudo que nao for letra, digito, sublinhado ou hifen vira hifen; e
 * hifen nas pontas cai. E dela que sai `1DE` -> `1de` e
 * `VBE_L_PNT_NOVA` -> `vbe_l_pnt_nova`.
 *
 * @param {string} pasta - Nome da pasta na arvore de origem.
 * @returns {string} O slug, ou string vazia se nao sobrar nada.
 */
export function paraSlug(pasta) {
  return String(pasta || '').toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * A pasta que a url do config aponta, ja como slug.
 *
 * A url termina no ARQUIVO (`tileset.json`, `TGL.glb`), e a pasta e o segmento
 * anterior. Uma url que termina na propria pasta tambem serve.
 *
 * @param {string} url - A `url` de uma entrada de `config.tilesets`.
 * @returns {string|null} O slug da pasta, ou null se a url nao disser nada.
 */
export function slugDaUrl(url) {
  if (!url) return null;
  const partes = String(url).split('/').filter(Boolean);
  if (!partes.length) return null;
  const ultimo = partes[partes.length - 1];
  const pasta = ultimo.includes('.') ? partes[partes.length - 2] : ultimo;
  const slug = paraSlug(pasta);
  return slug || null;
}
