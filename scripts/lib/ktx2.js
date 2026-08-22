/**
 * @module scripts/lib/ktx2
 * @description Codifica uma textura em KTX2/ETC1S, chamando o `ktx` do
 * KTX-Software.
 *
 * POR QUE O SHARP ENTRA ANTES DO `ktx`. O KTX-Software nao le WebP, e 7 modelos
 * do acervo (11,21 GiB, todos do DJI Terra) tem a textura em WebP. Sem este
 * passo o codificador PULA a textura com um aviso que passa despercebido, o
 * arquivo sai 42% MAIOR (porque o Draco foi desfeito e nada foi comprimido no
 * lugar) e a conversao parece ter dado certo. Foi medido.
 *
 * POR QUE ETC1S E NAO UASTC. Medido em 60 tiles reais do acervo, com Draco
 * reaplicado nos dois casos: UASTC custa de 2,8 a 4 vezes o tamanho do arquivo
 * de hoje. Ele existe para normal map e arte principal, nao para ortofoto de
 * fotogrametria.
 *
 * POR QUE qlevel 200. E o joelho medido da curva de qualidade (PSNR contra a
 * textura de origem ja decodificada):
 *
 *            Metashape    DJI Terra
 *   q128     35,33 dB     29,84 dB
 *   q200     37,15 dB     32,84 dB
 *   q255     37,31 dB     33,83 dB
 *
 * De 200 para 255 o Metashape ganha 0,16 dB e paga 8% de bytes. O q128 e barato
 * demais no DJI Terra: 24,67 dB no pior caso deixa artefato visivel em telhado e
 * asfalto.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);

/** Caminho do binario `ktx`. Sobreponivel por KTX_BIN. */
const KTX_BIN = process.env.KTX_BIN || 'ktx';

/** Qualidade padrao do basis-lz. Ver o cabecalho deste modulo. */
export const QLEVEL_PADRAO = 200;

/**
 * Nivel de compressao do basis-lz (velocidade contra taxa), separado do qlevel.
 * 2 e o meio da faixa: em 1 o arquivo cresce sem ganho de qualidade, e em 5 o
 * tempo por textura dobra para economizar poucos por cento.
 */
const CLEVEL = 2;

/**
 * Cria um diretorio temporario proprio do processo.
 *
 * Um por WORKER, e nao um por textura: o custo de criar e apagar diretorio a
 * cada tile aparece quando sao milhoes deles.
 * @returns {string}
 */
export function abrirTemporario() {
  return mkdtempSync(join(tmpdir(), 'ebgeo3d-'));
}

/** @param {string} dir */
export function fecharTemporario(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Dimensao final de uma textura, depois do teto e do alinhamento de bloco.
 *
 * DUAS REGRAS, NESTA ORDEM.
 *
 * 1. TETO DE RESOLUCAO. Reduz o LADO MAIOR ate `maxTextura`, mantendo a
 *    proporcao: uma 1024x512 com teto 512 vira 512x256, e a UV do tile continua
 *    valendo. `maxTextura` 0 desliga.
 *
 *    O teto existe porque o excesso e da ORIGEM, e nao do acervo. O DJI Terra
 *    exporta 1024x1024 e o Metashape 256 a 512. Medido no Silo: as texturas
 *    acima de 512x512 sao 67,8% dos bytes de textura e 77,5% da VRAM de
 *    textura; na Ponte de Quatis, do Metashape, sao 0%.
 *
 * 2. ALINHAMENTO DE BLOCO. ETC1S trabalha em blocos de 4x4. Dimensao que nao e
 *    multipla de 4 faz o codificador preencher a borda por conta propria, e o
 *    preenchimento sangra para dentro do tile vizinho na costura. Cortar para o
 *    multiplo de 4 abaixo perde no maximo 3 pixels de uma borda que a UV do tile
 *    ja nao usa.
 *
 * @param {number} largura
 * @param {number} altura
 * @param {number} [maxTextura] - teto do lado maior, em pixels; 0 desliga
 * @returns {{largura:number, altura:number}}
 */
export function dimensaoAlvo(largura, altura, maxTextura = 0) {
  let l = largura;
  let a = altura;
  if (maxTextura > 0 && Math.max(l, a) > maxTextura) {
    const fator = maxTextura / Math.max(l, a);
    l = Math.max(4, Math.round(l * fator));
    a = Math.max(4, Math.round(a * fator));
  }
  return {
    largura: Math.max(4, l - (l % 4)),
    altura: Math.max(4, a - (a % 4)),
  };
}

/**
 * Codifica uma imagem em KTX2/ETC1S com mipmaps.
 *
 * @param {Buffer} imagem - JPEG, PNG ou WebP embutido no glTF
 * @param {object} opcoes
 * @param {string} opcoes.tmp - Diretorio temporario do worker
 * @param {number} opcoes.seq - Sequencial, para nomes nao colidirem no diretorio
 * @param {number} [opcoes.qlevel]
 * @param {number} [opcoes.maxTextura] - teto do lado maior, em pixels; 0 desliga
 * @returns {Promise<Buffer|null>} O KTX2, ou null se o codificador recusou
 */
export async function paraKTX2(imagem, { tmp, seq, qlevel = QLEVEL_PADRAO, maxTextura = 0 }) {
  const png = join(tmp, `t${seq}.png`);
  const ktx = join(tmp, `t${seq}.ktx2`);

  const meta = await sharp(imagem).metadata();
  const { largura, altura } = dimensaoAlvo(meta.width, meta.height, maxTextura);

  await sharp(imagem)
    .resize(largura, altura, { fit: 'fill' })
    // removeAlpha porque textura de fotogrametria e opaca, e um canal alfa
    // constante empurraria o basis para o modo de duas camadas, que custa mais.
    .removeAlpha()
    // compressionLevel 1: este PNG e insumo do `ktx` e vive alguns milissegundos.
    // Comprimi-lo bem seria trabalho jogado fora.
    .png({ compressionLevel: 1 })
    .toFile(png);

  try {
    await execFileAsync(KTX_BIN, [
      'create',
      '--format', 'R8G8B8_SRGB',
      '--assign-tf', 'srgb',
      '--encode', 'basis-lz',
      '--clevel', String(CLEVEL),
      '--qlevel', String(qlevel),
      '--generate-mipmap',
      png, ktx,
    ]);
    return readFileSync(ktx);
  } catch {
    return null;
  } finally {
    // OS DOIS SAEM AQUI, e nao no fim da corrida. O diretorio temporario so e
    // apagado quando o worker termina (fecharTemporario), entao sem este bloco
    // um modelo de 247.125 tiles deixa esse tanto de PNG sem compressao no disco
    // de SISTEMA, que costuma ser o menor da maquina. O `finally` cobre tambem o
    // caminho de erro, onde o PNG ja existe e o KTX2 talvez nao.
    apaga(png);
    apaga(ktx);
  }
}

/** Apaga sem reclamar de arquivo que nao chegou a existir. */
function apaga(caminho) {
  try { unlinkSync(caminho); } catch { /* nao existe: nada a fazer */ }
}

/**
 * Confere se o binario `ktx` responde, e devolve a versao.
 *
 * A IMPORTACAO CHAMA ISTO ANTES DE COMECAR. Sem a conferencia, um `ktx` ausente
 * viraria "textura pulada" em cada um dos milhoes de tiles, e a corrida
 * terminaria com um acervo inteiro sem compressao de textura e sem um erro.
 * @returns {Promise<string>}
 * @throws {Error} se o binario nao existe ou nao responde
 */
export async function versaoKtx() {
  try {
    const { stdout } = await execFileAsync(KTX_BIN, ['--version']);
    return stdout.trim();
  } catch (err) {
    throw new Error(
      `binario '${KTX_BIN}' nao responde (${err.code || err.message}). `
      + 'Instale o KTX-Software 4.4+ ou aponte KTX_BIN para o executavel.',
    );
  }
}
