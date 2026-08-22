/**
 * @module config
 * @description Configuracao do servico, com sobreposicao por variavel de ambiente.
 *
 * Espelha o desenho do ebgeo_360: um diretorio de dados com o index.db no topo e
 * um banco por unidade servida (la e o projeto, aqui e o modelo).
 */

import { resolve } from 'node:path';

const config = {
  port: parseInt(process.env.PORT || '8082', 10),
  host: process.env.HOST || '0.0.0.0',

  // Diretorio de dados: index.db e models/*.3dtiles
  dataDir: resolve(process.env.EBGEO3D_DATA_DIR || './data'),

  /** Banco central de metadado (sem BLOB). */
  get indexDbPath() {
    return resolve(this.dataDir, 'index.db');
  },

  /** Diretorio dos bancos por modelo. */
  get modelsDbDir() {
    return resolve(this.dataDir, 'models');
  },

  /** Miniaturas e videos de previa servidos como arquivo. */
  get assetsDir() {
    return resolve(this.dataDir, 'assets');
  },

  logLevel: process.env.LOG_LEVEL || 'info',
  corsOrigin: process.env.CORS_ORIGIN || '*',

  /**
   * Cache de conteudo imutavel: um ano.
   *
   * O tile so pode levar `immutable` porque a URI dele carrega o token de
   * geracao (ver docs/formato.md). Sem o token, regerar o modelo trocaria os
   * bytes sem trocar a URL, e o navegador passaria um ano compondo tile velho
   * dentro da arvore nova. Nao e hipotese: o ebgeo_360 ja pagou esse defeito.
   */
  tileCacheMaxAge: 31536000,

  /**
   * Teto de tiles em voo por processo.
   *
   * O tile 3D medio pesa 44 KiB (medido no acervo de 2,26 milhoes), entao 64 em
   * voo somam menos de 3 MB de heap. O limite existe pelo mesmo motivo do 360:
   * sem teto, uma rajada abre buffers sem limite. E 64 nao enfileira a rajada
   * normal do Cesium, que pede algumas dezenas de tiles por quadro.
   */
  maxInflightTiles: parseInt(process.env.MAX_INFLIGHT_TILES || '64', 10),

  /**
   * Quantos bancos de modelo ficam abertos ao mesmo tempo.
   *
   * O ebgeo_360 guarda as conexoes num Map SEM DESPEJO, e la isso e seguro: sao
   * 27 projetos. Aqui sao 115 modelos, e com o cache de 32 MB por banco o mesmo
   * desenho reservaria 3,7 GB dentro de um container limitado a 512 MB. Por isso
   * a conexao entra num LRU com teto. Ver src/db/connection.js.
   */
  maxOpenModels: parseInt(process.env.MAX_OPEN_MODELS || '12', 10),

  /**
   * Cache de pagina por banco de modelo, em KB (valor negativo do SQLite).
   *
   * 8 MB, e nao os 32 MB do 360, porque aqui ha 115 bancos e nao 27: o produto
   * com maxOpenModels e que tem de caber no container (12 x 8 MB = 96 MB).
   */
  modelCacheSizeKb: parseInt(process.env.MODEL_CACHE_SIZE_KB || '-8000', 10),

  /**
   * mmap por banco de modelo, em bytes.
   *
   * Endereco virtual, nao residente: o que conta no RSS e a pagina tocada. 64 MB
   * cobre com folga o conjunto quente de uma cena. O 360 usa 256 MB porque o
   * BLOB dele e uma foto inteira de ate 4 MB.
   */
  modelMmapBytes: parseInt(process.env.MODEL_MMAP_BYTES || String(64 * 1024 * 1024), 10),
};

export default config;
