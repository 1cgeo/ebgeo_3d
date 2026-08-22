/**
 * @module db/queries
 * @description Prepared statements do index.db (catalogo dos modelos).
 *
 * Padrao "prepare once" do ebgeo_360: o statement se prepara na primeira chamada
 * e vive no cache, com a conexao guardada junto. Se closeAll() trocar a conexao,
 * a comparacao de identidade refaz os statements sozinha, em vez de estourar
 * "The database connection is not open" na chamada seguinte.
 */

import { getIndexDb } from './connection.js';

let _db = null;
let _stmts = null;

/** Invalida o cache de statements. Chamado por closeAll(). */
export function resetStatements() {
  _db = null;
  _stmts = null;
}

function stmts() {
  const db = getIndexDb();
  if (_stmts && _db === db) return _stmts;
  _db = db;
  _stmts = {
    listar: db.prepare(`
      SELECT id, name, source, captured_at, tiles_version, geometry_codec,
             texture_codec, texture_quality, tile_count, total_bytes,
             build_token, built_at, lon, lat, height, ground_height, height_offset, max_sse,
             description, local, keywords, preview_video, preview_thumb
        FROM models
       WHERE published = 1
       ORDER BY name
    `),
    porId: db.prepare('SELECT * FROM models WHERE id = ? AND published = 1'),
    porIdQualquer: db.prepare('SELECT * FROM models WHERE id = ?'),
    contar: db.prepare('SELECT COUNT(*) AS n FROM models WHERE published = 1'),
    somar: db.prepare('SELECT COALESCE(SUM(total_bytes),0) AS b, COALESCE(SUM(tile_count),0) AS t FROM models WHERE published = 1'),
    upsert: db.prepare(`
      INSERT INTO models (
        id, name, db_filename, source, source_version, captured_at,
        tiles_version, geometry_codec, texture_codec, texture_quality,
        tile_count, json_count, total_bytes, source_bytes,
        build_token, built_at, lon, lat, height, ground_height, height_offset, max_sse,
        description, local, keywords, preview_video, preview_thumb, published
      ) VALUES (
        @id, @name, @db_filename, @source, @source_version, @captured_at,
        @tiles_version, @geometry_codec, @texture_codec, @texture_quality,
        @tile_count, @json_count, @total_bytes, @source_bytes,
        @build_token, @built_at, @lon, @lat, @height, @ground_height, @height_offset, @max_sse,
        @description, @local, @keywords, @preview_video, @preview_thumb, @published
      )
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, db_filename=excluded.db_filename,
        source=excluded.source, source_version=excluded.source_version,
        captured_at=COALESCE(excluded.captured_at, models.captured_at),
        tiles_version=excluded.tiles_version,
        geometry_codec=excluded.geometry_codec,
        texture_codec=excluded.texture_codec,
        texture_quality=excluded.texture_quality,
        tile_count=excluded.tile_count, json_count=excluded.json_count,
        total_bytes=excluded.total_bytes, source_bytes=excluded.source_bytes,
        build_token=excluded.build_token, built_at=excluded.built_at,
        -- O que o operador editou no catalogo NAO se perde numa reimportacao:
        -- COALESCE mantem o valor de hoje quando a importacao nao traz um novo.
        lon=COALESCE(excluded.lon, models.lon),
        lat=COALESCE(excluded.lat, models.lat),
        height=COALESCE(excluded.height, models.height),
        -- ground_height E MEDIDA, e por isso NAO leva COALESCE: uma reimportacao
        -- que reconverte a geometria tem de sobrescrever a altura antiga.
        ground_height=excluded.ground_height,
        height_offset=COALESCE(excluded.height_offset, models.height_offset),
        max_sse=COALESCE(excluded.max_sse, models.max_sse),
        description=COALESCE(excluded.description, models.description),
        local=COALESCE(excluded.local, models.local),
        keywords=COALESCE(excluded.keywords, models.keywords),
        preview_video=COALESCE(excluded.preview_video, models.preview_video),
        preview_thumb=COALESCE(excluded.preview_thumb, models.preview_thumb)
    `),
    abrirImport: db.prepare(`
      INSERT INTO imports (model_id, started_at, status, source_path)
      VALUES (?, ?, 'rodando', ?)
    `),
    fecharImport: db.prepare(`
      UPDATE imports SET finished_at=@finished_at, status=@status,
             tiles_in=@tiles_in, tiles_out=@tiles_out, textures=@textures,
             failures=@failures, seconds=@seconds, ratio=@ratio, notes=@notes
       WHERE id=@id
    `),
    ultimosImports: db.prepare(`
      SELECT * FROM imports WHERE model_id = ? ORDER BY started_at DESC LIMIT ?
    `),
  };
  return _stmts;
}

/** @returns {Array<object>} Modelos publicados, para o catalogo. */
export function listModels() {
  return stmts().listar.all();
}

/** @param {string} id @returns {object|undefined} */
export function getModel(id) {
  return stmts().porId.get(id);
}

/** @param {string} id @returns {object|undefined} Inclusive nao publicado. */
export function getModelAny(id) {
  return stmts().porIdQualquer.get(id);
}

/** @returns {number} Quantidade de modelos publicados. Usado pelo /health. */
export function getModelCount() {
  return stmts().contar.get().n;
}

/** @returns {{bytes:number, tiles:number}} Totais do acervo publicado. */
export function getTotals() {
  const r = stmts().somar.get();
  return { bytes: r.b, tiles: r.t };
}

/** @param {object} m Linha completa de models. */
export function upsertModel(m) {
  stmts().upsert.run(m);
}

/**
 * Abre o registro de uma importacao e devolve o id da linha.
 * @param {string} modelId @param {string} sourcePath @returns {number}
 */
export function openImport(modelId, sourcePath) {
  const r = stmts().abrirImport.run(modelId, new Date().toISOString(), sourcePath);
  return Number(r.lastInsertRowid);
}

/** @param {object} row Campos de fecho, com `id` da linha aberta. */
export function closeImport(row) {
  stmts().fecharImport.run(row);
}

/** @param {string} modelId @param {number} [limite] */
export function listImports(modelId, limite = 5) {
  return stmts().ultimosImports.all(modelId, limite);
}
