-- ============================================================
-- {slug}.3dtiles — um modelo inteiro num arquivo.
--
-- O NOME DA TABELA E `media`, E AS COLUNAS SAO `key` E `content`, porque este e
-- o formato .3dtiles do 3d-tiles-tools do Cesium. Nao e invencao da casa: um
-- arquivo escrito aqui abre com `npx 3d-tiles-tools convert`, e um arquivo
-- escrito por eles abre aqui. Trocar o nome por algo mais bonito custaria essa
-- compatibilidade e nao compraria nada.
--
-- `key` e o caminho relativo dentro do tileset, com barra normal e sem barra
-- inicial: "tileset.json", "Data/c00.glb", "Data/d000/tileset.json".
--
-- PAGE_SIZE FICA NO PADRAO 4096. O ebgeo_360 usa 65536 e esta certo la, porque o
-- BLOB dele e uma foto de 500 KB a 4 MB. Aqui o tile medio tem 39,9 KiB, menor
-- que uma pagina de 64 KB, e o resto da pagina vira desperdicio. Medido no
-- Ponte_Quatis (7.501 tiles, 288 MiB):
--
--   page   disco    leitura (mediana de 7 rodadas intercaladas)
--   4 KB   +2,1%    27.012 tiles/s
--  16 KB   +6,9%    30.959 tiles/s
--  64 KB  +21,9%    30.022 tiles/s
--
-- A diferenca de leitura cabe dentro da variacao de cada medida, e as tres estao
-- duas ordens de grandeza acima do que uma cena do Cesium pede. O que sobra e o
-- disco: em 104 GiB de acervo, 4 KB contra 64 KB sao cerca de 20 GiB.
-- ============================================================

CREATE TABLE IF NOT EXISTS media (
    key      TEXT PRIMARY KEY,
    content  BLOB NOT NULL
);

-- Cabecalho do proprio arquivo, para ele se identificar sem o index.db.
-- Um .3dtiles copiado solto para outra maquina continua dizendo o que e.
--
-- A tabela e chave-valor de proposito: campo novo nao pede ALTER TABLE, e um
-- leitor antigo ignora o que nao conhece em vez de quebrar.
CREATE TABLE IF NOT EXISTS meta (
    key    TEXT PRIMARY KEY,
    value  TEXT
);
