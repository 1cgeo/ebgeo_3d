/**
 * @module scripts/lib/conversor
 * @description Converte um tile b3dm (3D Tiles 1.0) em glb (3D Tiles 1.1) com
 * textura KTX2/ETC1S e geometria Draco.
 *
 * PENSADO PARA RODAR DENTRO DE UM WORKER, e por isso o estado caro (os modulos
 * wasm do Draco, o diretorio temporario) vive num objeto que se cria UMA vez e
 * se reaproveita por milhares de tiles. O primeiro desenho chamava a linha de
 * comando do gltf-transform tres vezes por tile e custava 1.720 ms por tile, dos
 * quais quase tudo era subir o Node de novo. Este custa 607 ms num processo so,
 * e 32 ms com doze.
 *
 * A ORDEM DAS OPERACOES NAO E LIVRE. A textura vem antes da geometria porque
 * mexer na textura obriga a decodificar o documento inteiro, e o Draco tem de
 * ser reaplicado DEPOIS. Inverter a ordem entrega um arquivo sem compressao de
 * geometria, e o sintoma e `extensionsUsed` vazio na saida, nunca um erro.
 */

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRTextureBasisu, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { abrirTile } from './b3dm.js';
import { paraKTX2, abrirTemporario, fecharTemporario, QLEVEL_PADRAO } from './ktx2.js';

/**
 * @typedef {object} Conversor
 * @property {(buf: Buffer, qlevel?: number) => Promise<ResultadoTile>} converte
 * @property {() => void} fecha
 */

/**
 * @typedef {object} ResultadoTile
 * @property {Buffer} glb
 * @property {number} texturas   - Texturas efetivamente codificadas
 * @property {number} falhas     - Texturas que o codificador recusou
 * @property {number} triangulos
 * @property {boolean} batchTableDescartada
 */

/**
 * Monta um conversor. Caro: chame uma vez por worker.
 * @returns {Promise<Conversor>}
 */
export async function criarConversor() {
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'draco3d.encoder': await draco3d.createEncoderModule(),
    });

  const tmp = abrirTemporario();
  let seq = 0;

  return {
    async converte(buf, qlevel = QLEVEL_PADRAO) {
      const envelope = abrirTile(buf);
      const doc = await io.readBinary(new Uint8Array(envelope.glb));

      const basisu = doc.createExtension(KHRTextureBasisu).setRequired(true);
      let texturas = 0;
      let falhas = 0;

      for (const tex of doc.getRoot().listTextures()) {
        const imagem = tex.getImage();
        if (!imagem) continue;
        const ktx = await paraKTX2(Buffer.from(imagem), { tmp, seq: seq++, qlevel });
        if (!ktx) { falhas++; continue; }
        tex.setImage(new Uint8Array(ktx)).setMimeType('image/ktx2');
        texturas++;
      }
      // Declarar KHR_texture_basisu como REQUIRED sem nenhuma textura KTX2
      // faria um cliente conforme recusar um arquivo que esta perfeito.
      if (texturas === 0) basisu.dispose();

      doc.createExtension(KHRDracoMeshCompression)
        .setRequired(true)
        .setEncoderOptions({ method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER });

      let triangulos = 0;
      for (const malha of doc.getRoot().listMeshes()) {
        for (const prim of malha.listPrimitives()) {
          const indices = prim.getIndices();
          if (indices) triangulos += Math.floor(indices.getCount() / 3);
        }
      }

      const saida = await io.writeBinary(doc);
      return {
        glb: Buffer.from(saida),
        texturas,
        falhas,
        triangulos,
        batchTableDescartada: envelope.temBatchTable,
      };
    },
    fecha() {
      fecharTemporario(tmp);
    },
  };
}
