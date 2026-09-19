// 截图压缩：越小越好，但保住文字清晰度。
//
// 长截图内容以文字为主，故：
//   · 用 WebP 有损（比 PNG 小 60~80%，文字边缘远好于 JPEG，不会出现块状振铃）
//   · 宽度收敛到上限（原生 1280 等比缩到 900，12px 正文仍清晰可读）
//   · 仍超目标体积 → 逐级降质量 → 再降宽度，直到达标或触底
// deviceScaleFactor 固定为 1（2x 会让体积翻 4 倍）。

import sharp from 'sharp';
import { config } from '../config/index.js';

export interface CompressResult {
  /** 压缩后的图片内容 */
  buffer: Buffer;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  /** 实际用到的质量与宽度（排查用） */
  quality: number;
  scaled: boolean;
}

const MIN_QUALITY = 55;
const MIN_WIDTH = 720;

async function encode(src: Buffer, quality: number, width?: number): Promise<Buffer> {
  const img = sharp(src, { limitInputPixels: false });
  const pipeline = width ? img.resize({ width, withoutEnlargement: true }) : img;
  const { format } = config.shot;
  if (format === 'jpeg') return pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
  if (format === 'png') return pipeline.png({ compressionLevel: 9 }).toBuffer();
  return pipeline.webp({ quality }).toBuffer();
}

const mimeOf = (): string =>
  config.shot.format === 'jpeg' ? 'image/jpeg' : config.shot.format === 'png' ? 'image/png' : 'image/webp';

/**
 * 自适应压缩到目标体积以内。
 * 顺序：原始宽度 + 起始质量 → 降质量（5 级）→ 降宽度（每级 -90px，下限 720）→ 触底则按当前结果返回
 */
export async function compressScreenshot(src: Buffer): Promise<CompressResult> {
  const { quality: q0, maxWidth, maxBytes } = config.shot;
  const meta = await sharp(src, { limitInputPixels: false }).metadata();
  const origWidth = meta.width ?? 0;
  const startWidth = origWidth > maxWidth ? maxWidth : undefined;

  let best: CompressResult | null = null;

  // 第一轮：固定宽度，逐步降质量
  for (let q = q0; q >= MIN_QUALITY; q -= 8) {
    const buf = await encode(src, q, startWidth);
    const m = await sharp(buf).metadata();
    best = {
      buffer: buf,
      mime: mimeOf(),
      width: m.width ?? 0,
      height: m.height ?? 0,
      bytes: buf.length,
      quality: q,
      scaled: !!startWidth,
    };
    if (buf.length <= maxBytes) return best;
  }

  // 第二轮：仍超限 → 逐级缩宽度
  let w = (startWidth ?? origWidth) - 90;
  while (w >= MIN_WIDTH) {
    const buf = await encode(src, MIN_QUALITY, w);
    const m = await sharp(buf).metadata();
    best = {
      buffer: buf,
      mime: mimeOf(),
      width: m.width ?? 0,
      height: m.height ?? 0,
      bytes: buf.length,
      quality: MIN_QUALITY,
      scaled: true,
    };
    if (buf.length <= maxBytes) return best;
    w -= 90;
  }
  return best!;
}

/** 压缩并转成 base64（回推接口要的就是 base64 字符串） */
export async function compressToBase64(src: Buffer): Promise<string> {
  const r = await compressScreenshot(src);
  return `data:${r.mime};base64,${r.buffer.toString('base64')}`;
}
