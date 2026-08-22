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
import { ALL_EXTENSIONS, KHRTextureBasisu, KHRDracoMeshCompression, EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { abrirTile, leGerador } from './b3dm.js';
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
export async function criarConversor({ geometria = 'draco', upAxis = 'Y', maxTextura = 0 } = {}) {
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'draco3d.encoder': await draco3d.createEncoderModule(),
      'meshopt.decoder': MeshoptDecoder,
      'meshopt.encoder': MeshoptEncoder,
    });

  const tmp = abrirTemporario();
  let seq = 0;
  // O gerador e o mesmo no modelo inteiro: le-se do primeiro tile e pronto.
  let gerador;

  return {
    async converte(buf, qlevel = QLEVEL_PADRAO) {
      const envelope = abrirTile(buf);
      // Antes do readBinary, que sobrescreve o campo. Ver leGerador em b3dm.js.
      if (gerador === undefined) gerador = leGerador(envelope.glb);
      const doc = await io.readBinary(new Uint8Array(envelope.glb));

      // Z-UP VIRA Y-UP AQUI, na geometria, e nao numa declaracao no tileset.
      //
      // O DJI Terra grava `asset.gltfUpAxis: "Z"` no tileset.json, e o conteudo
      // glTF dele esta MESMO em Z-up. Aquele campo nunca existiu no esquema de
      // 3D Tiles 1.1, entao a conversao o remove; removido sem mais nada, o
      // Cesium passa a ler o conteudo como Y-up e o modelo aparece DE PE.
      // Aconteceu com o Silo Oreste Ceretta, e o chefe viu na tela.
      //
      // Rotacionar a geometria e a saida certa: o arquivo fica conforme 1.1 e
      // para de depender de o Cesium continuar tolerando um campo fora do
      // esquema. A matriz e a Z_UP_TO_Y_UP do proprio Cesium: x fica, y recebe
      // z, e z recebe -y.
      if (upAxis === 'Z') {
        const rot = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
        for (const cena of doc.getRoot().listScenes()) {
          for (const no of cena.listChildren()) {
            no.setMatrix(multiplica(rot, no.getMatrix()));
          }
        }
      }

      const basisu = doc.createExtension(KHRTextureBasisu).setRequired(true);
      let texturas = 0;
      let falhas = 0;

      for (const tex of doc.getRoot().listTextures()) {
        const imagem = tex.getImage();
        if (!imagem) continue;
        const ktx = await paraKTX2(Buffer.from(imagem), { tmp, seq: seq++, qlevel, maxTextura });
        if (!ktx) { falhas++; continue; }
        tex.setImage(new Uint8Array(ktx)).setMimeType('image/ktx2');
        texturas++;
      }
      // Declarar KHR_texture_basisu como REQUIRED sem nenhuma textura KTX2
      // faria um cliente conforme recusar um arquivo que esta perfeito.
      if (texturas === 0) basisu.dispose();

      // A EXTENSAO DE GEOMETRIA DA ORIGEM SAI PRIMEIRO. Ler um b3dm com Draco
      // registra KHR_draco_mesh_compression no Document, e ela SOBREVIVE a
      // leitura mesmo que a saida use outro codec: o arquivo saia declarando
      // Draco e meshopt ao mesmo tempo, os dois como obrigatorios, e o CesiumJS
      // recusa em silencio (13 tiles no tileset, 0 prontos, 0 pendentes).
      for (const ext of doc.getRoot().listExtensionsUsed()) {
        const nome = ext.extensionName;
        if (nome === 'KHR_draco_mesh_compression'
          || nome === 'EXT_meshopt_compression'
          || nome === 'KHR_mesh_quantization') ext.dispose();
      }

      // A COMPRESSAO DE GEOMETRIA E CONFIGURAVEL PORQUE A ESCOLHA E MEDIDA, e a
      // medida depende do cliente: o CesiumJS decodifica Draco numa thread so.
      // Ver docs/desempenho.md.
      if (geometria === 'draco') {
        doc.createExtension(KHRDracoMeshCompression)
          .setRequired(true)
          .setEncoderOptions({ method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER });
      } else if (geometria === 'meshopt') {
        // meshopt exige quantizacao: ele comprime bufferView otimizado para GPU.
        doc.createExtension(KHRMeshQuantization).setRequired(true);
        doc.createExtension(EXTMeshoptCompression)
          .setRequired(true)
          .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
      } else if (geometria === 'quantize') {
        doc.createExtension(KHRMeshQuantization).setRequired(true);
      }

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
        // O MOTOR SAI DO ARQUIVO, nunca do nome da pasta. E o campo que diz se o
        // modelo veio do Metashape ou do DJI Terra, e as duas saidas diferem em
        // tudo que importa aqui: tamanho de textura, formato dela e triangulos
        // por tile. Lido do JSON cru, que e o unico lugar onde ele sobrevive.
        gerador,
      };
    },
    fecha() {
      fecharTemporario(tmp);
    },
  };
}

/**
 * Multiplica duas matrizes 4x4 em ordem de coluna, que e a do glTF.
 *
 * Escrita a mao porque a alternativa seria puxar uma biblioteca de algebra
 * inteira para uma unica multiplicacao por tile.
 *
 * @param {number[]} a @param {number[]} b @returns {number[]} a x b
 */
function multiplica(a, b) {
  const r = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let l = 0; l < 4; l++) {
      let soma = 0;
      for (let k = 0; k < 4; k++) soma += a[k * 4 + l] * b[c * 4 + k];
      r[c * 4 + l] = soma;
    }
  }
  return r;
}
