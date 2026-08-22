/**
 * @module scripts/lib/b3dm
 * @description Leitura do envelope b3dm (3D Tiles 1.0) e do proprio glb.
 *
 * O b3dm e um cabecalho de 28 bytes, duas tabelas opcionais e um glTF binario
 * colado no fim. Converter para 1.1 e, na parte do container, so descartar o
 * envelope: o glTF de dentro ja e um glb valido.
 *
 * O QUE SE PERDE AO DESCARTAR O ENVELOPE. A batch table do b3dm carregava
 * atributo por objeto para picking. No acervo da DGEO ela vem VAZIA nos modelos
 * do Metashape e presente mas sem propriedade util nos do DJI Terra, e o
 * equivalente em 1.1 seria EXT_structural_metadata, que ninguem consome hoje.
 * Se um dia um modelo trouxer batch table com conteudo, este modulo tem de
 * avisar em vez de jogar fora calado: e o que `temBatchTable` existe para dizer.
 */

/** Tamanho do cabecalho b3dm, em bytes. */
const CABECALHO = 28;

/**
 * @typedef {object} Envelope
 * @property {Buffer} glb        - O glTF binario de dentro
 * @property {boolean} temBatchTable - Se a batch table JSON tem conteudo
 * @property {boolean} temFeatureTable - Se a feature table JSON tem conteudo
 */

/**
 * Extrai o glb de um buffer b3dm. Um buffer que ja e glb passa direto.
 * @param {Buffer} buf
 * @returns {Envelope}
 * @throws {Error} se o container nao for b3dm nem glb
 */
export function abrirTile(buf) {
  const magic = buf.toString('ascii', 0, 4);
  if (magic === 'glTF') {
    return { glb: buf, temBatchTable: false, temFeatureTable: false };
  }
  if (magic !== 'b3dm') {
    throw new Error(`container nao suportado: ${JSON.stringify(magic)}`);
  }

  const ftJSON = buf.readUInt32LE(12);
  const ftBIN = buf.readUInt32LE(16);
  const btJSON = buf.readUInt32LE(20);
  const btBIN = buf.readUInt32LE(24);
  const inicio = CABECALHO + ftJSON + ftBIN + btJSON + btBIN;

  if (buf.toString('ascii', inicio, inicio + 4) !== 'glTF') {
    throw new Error('b3dm sem glTF no deslocamento esperado');
  }
  // O comprimento vem do PROPRIO glb, e nao do byteLength do b3dm: alguns
  // geradores deixam bytes de alinhamento depois do payload, e passar esse rabo
  // adiante faz o leitor de glTF reclamar de chunk desconhecido.
  const comprimento = buf.readUInt32LE(inicio + 8);

  return {
    glb: buf.subarray(inicio, inicio + comprimento),
    // Uma tabela vazia vem como `{}` (2 bytes) ou com comprimento zero. Nos dois
    // casos nao ha nada a preservar.
    temBatchTable: btJSON > 2,
    temFeatureTable: ftJSON > 2,
  };
}

/**
 * Diz o tipo de container de um buffer, sem interpreta-lo.
 * @param {Buffer} buf
 * @returns {'b3dm'|'glb'|'pnts'|'i3dm'|'cmpt'|'desconhecido'}
 */
export function tipoDeTile(buf) {
  if (buf.length < 4) return 'desconhecido';
  const magic = buf.toString('ascii', 0, 4);
  if (magic === 'glTF') return 'glb';
  if (magic === 'b3dm' || magic === 'pnts' || magic === 'i3dm' || magic === 'cmpt') return magic;
  return 'desconhecido';
}
