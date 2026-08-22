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

    -- Altura elipsoidal do CHAO do modelo, medida pelo envelope geodesico na
    -- importacao (mediana das alturas dos cantos dos tiles de conteudo).
    -- E dado, nao ajuste: nao se edita a mao. Serve para duas coisas.
    --   1. Um cliente SEM terreno ve o modelo flutuar exatamente esta altura,
    --      e o contorno e publicar heightOffset = -ground_height.
    --   2. Um `height_offset` que nao seja 0 nem -ground_height denuncia
    --      ajuste no olho, que e o que poe modelo enterrado.
    ground_height   REAL,

    -- Altura elipsoidal do PONTO MAIS BAIXO do modelo, medida pelo mesmo
    -- envelope. E ela, e nao `ground_height`, que decide o `height_offset` de um
    -- cliente sem terreno: com `-ground_height` a parte baixa do modelo afunda
    -- abaixo do chao liso, o globo a corta por dentro, e as duas superficies
    -- brigam pelo mesmo pixel. Medido no Silo: a base caia a -22,8 m.
    min_height      REAL,

    -- Ajuste vertical publicado ao cliente. Com o terreno da DGEO no ar ele e 0.
    -- No modelo GLB ele NAO e ajuste: e a altura em que o modelo e plantado.
    height_offset   REAL DEFAULT 0,

    -- ===== modelo GLB solto (model_type = 'glb') =====
    -- '3dtiles' (o padrao) ou 'glb'. O segundo e um arquivo unico, sem arvore e
    -- sem tileset.json, que o Cesium carrega por Model.fromGltfAsync.
    model_type      TEXT NOT NULL DEFAULT '3dtiles',

    -- ONDE PLANTAR. Um .glb comum traz coordenada LOCAL, e nao georreferencia:
    -- sem estes dois campos ele cai no centro da Terra. Eles vem do operador na
    -- importacao, e nao ha como medi-los do arquivo.
    position_lon    REAL,
    position_lat    REAL,

    -- Orientacao em graus, no referencial local do ponto.
    rot_heading     REAL,
    rot_pitch       REAL,
    rot_roll        REAL,

    -- Fator de escala uniforme. NULL significa 1.
    scale           REAL,
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


-- ============================================================
-- scenes — cenas navegaveis a pe (Gaussian Splatting).
--
-- O DADO DELAS NAO ENTRA EM SQLITE, e isso e deliberado. Uma cena e uma PASTA
-- que a pipeline produz de uma vez: o splat (`cena.sog`, dezenas de MB), o
-- octree de colisao, as fichas curadas e as fotos delas. O visualizador pede
-- esses arquivos por URL, um a um, e alguns em faixa. Enfia-los num BLOB
-- obrigaria o servico a reconstruir o que o sistema de arquivos ja faz melhor,
-- sem comprar nada: nao ha milhares de objetos pequenos aqui, que e o problema
-- que o .3dtiles resolve.
--
-- Aqui fica so o METADADO, que e o que o catalogo do EBGeo precisa e o que o
-- config do frontend deixa de carregar.
-- ============================================================
CREATE TABLE IF NOT EXISTS scenes (
    -- Slug estavel, e o nome da PASTA em data/scenes/.
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,

    -- ===== catalogo =====
    description     TEXT,
    local           TEXT,
    captured_at     TEXT,
    keywords        TEXT,            -- JSON array serializado

    -- Onde o pino cai no mapa 2D. E o que o usuario clica para entrar.
    lon             REAL,
    lat             REAL,

    -- ===== como o visitante entra =====
    -- Pose inicial MEDIDA no octree: por o visitante dentro do chao ou
    -- flutuando e o custo de mexer nisto sem remedir.
    pose_x          REAL,
    pose_y          REAL,
    pose_z          REAL,
    pose_yaw        REAL,
    pose_pitch      REAL,

    -- m/s. O padrao do motor de caminhada e 7 m/s, uma corrida de 25 km/h que
    -- passa reto pelas vitrines.
    velocidade      REAL,
    fov             REAL,

    -- ===== proveniencia =====
    bytes           INTEGER,
    file_count      INTEGER,
    imported_at     TEXT,

    published       INTEGER NOT NULL DEFAULT 1
);
