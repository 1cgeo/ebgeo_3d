-- ============================================================
-- index.db — catalogo dos modelos. Metadado apenas, nenhum BLOB.
-- Espelha o index.db do ebgeo_360.
-- ============================================================

CREATE TABLE IF NOT EXISTS models (
    -- Slug estavel, e o que aparece na URL: /api/v1/models/{id}/tileset.json.
    -- E o mesmo valor que o config.js do ebgeo_web usa como `id` do tileset,
    -- para o catalogo dos dois lados casar sem tabela de conversao.
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,

    -- Arquivo em data/models/. Guardado, e nao derivado do id, porque uma
    -- renomeacao do modelo nao pode obrigar a renomear o arquivo servido.
    db_filename     TEXT NOT NULL,

    -- ===== proveniencia =====
    -- Motor que gerou o modelo original: 'Agisoft Metashape', 'DJI Terra', ...
    -- Sai do campo asset.generator do glTF, nunca do nome da pasta.
    source          TEXT,
    -- Versao do 3D Tiles da ORIGEM, para o historico nao se perder na conversao.
    source_version  TEXT,
    captured_at     TEXT,

    -- ===== o que este banco contem =====
    tiles_version   TEXT NOT NULL DEFAULT '1.1',
    geometry_codec  TEXT,            -- 'draco'
    texture_codec   TEXT,            -- 'ktx2-etc1s'
    texture_quality INTEGER,         -- qlevel do basis-lz (200, ver docs/formato.md)
    tile_count      INTEGER NOT NULL,
    json_count      INTEGER NOT NULL,
    total_bytes     INTEGER NOT NULL,
    source_bytes    INTEGER,         -- bytes da arvore de origem, para medir a razao

    -- TOKEN DE GERACAO. Entra na URI de todo tile dentro dos tileset.json, e e
    -- o que separa a URL do tile velho da do novo sob `immutable` de um ano.
    -- Ver docs/formato.md, secao "O token de geracao".
    build_token     TEXT NOT NULL,
    built_at        TEXT NOT NULL,

    -- ===== como o EBGeo posiciona e navega =====
    lon             REAL,
    lat             REAL,
    height          REAL,
    height_offset   REAL DEFAULT 0,
    max_sse         REAL,            -- maximumScreenSpaceError sugerido

    -- ===== catalogo =====
    description     TEXT,
    local           TEXT,
    keywords        TEXT,            -- JSON array serializado
    preview_video   TEXT,
    preview_thumb   TEXT,

    -- Modelo importado mas ainda nao liberado responde 404 nas rotas publicas.
    published       INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_models_published ON models(published, id);

-- ============================================================
-- Registro das importacoes. Existe para a pergunta "quando este modelo
-- entrou, de onde veio, e o que a conferencia disse", que o campo built_at
-- sozinho nao responde depois da segunda importacao.
-- ============================================================

CREATE TABLE IF NOT EXISTS imports (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id        TEXT NOT NULL,
    started_at      TEXT NOT NULL,
    finished_at     TEXT,
    -- 'ok' | 'falhou'. O passo que reprovou vai em `notes`.
    status          TEXT NOT NULL,
    source_path     TEXT,
    tiles_in        INTEGER,
    tiles_out       INTEGER,
    textures        INTEGER,
    failures        INTEGER,
    seconds         REAL,
    ratio           REAL,
    notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_imports_model ON imports(model_id, started_at);
