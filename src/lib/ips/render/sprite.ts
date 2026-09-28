/**
 * 雪碧图裁切:把一张 cols×rows 网格大图裁成 N 张 135×240 帧。
 *
 * 用途(功能1):AI 用 mcp__img 生成一张 cols×rows 雪碧图大图(同一人物/场景做 N 个动作/数字),
 * 后端裁成 N 帧 → 存入用户图库(~/.lipai/gallery/<name>/)。
 *
 * 裁切逻辑(cover,整数坐标避免亚像素白边):
 * 1. 大图按 cols×rows 均分成 N 格(坐标全取整)
 * 2. 每格内缩几像素(避开网格线/格间缝隙)
 * 3. 格等比缩放到完全覆盖 135×240(scale 取 max),居中裁掉多出部分
 * 4. drawImage 源区/目标区全部整数 → 无亚像素采样,边缘干净
 */

import { loadImage, createCanvas, b64ToDataUrl } from './canvas-adapter';
import { CARD_W, CARD_H } from './canvas-kit';

/**
 * 把雪碧图大图裁成 cols×rows 帧(默认 5×2=10 帧)。
 * spriteBase64: 大图 base64(不含 data: 前缀)。
 * 返回 Uint8Array[](每帧 135×240 JPG)。
 */
export async function cropSpriteToFrames(
  spriteBase64: string,
  cols = 5,
  rows = 2,
): Promise<Uint8Array[]> {
  const img = await loadImage(b64ToDataUrl(spriteBase64));
  // 格尺寸取整(大图能被 cols/rows 整除时无误差;不能整除时向下取整,丢一点点边缘)
  const cellW = Math.floor(img.width / cols);
  const cellH = Math.floor(img.height / rows);
  // 内缩余量(像素,整数):避开网格线/格间缝隙。取格尺寸的 5%,至少 2px。
  const inset = Math.max(2, Math.round(Math.min(cellW, cellH) * 0.05));
  const frames: Uint8Array[] = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // 格区(内缩后,全部整数)
      const gx = c * cellW + inset;
      const gy = r * cellH + inset;
      const gw = cellW - inset * 2;
      const gh = cellH - inset * 2;
      // cover:scale = max(目标宽/格宽, 目标高/格高) → 缩放后宽高都 ≥ 目标
      const scale = Math.max(CARD_W / gw, CARD_H / gh);
      // 居中裁:缩放后格内取目标大小的区(居中),换算回原图坐标(÷ scale),取整
      const srcCW = Math.round(CARD_W / scale);
      const srcCH = Math.round(CARD_H / scale);
      const srcCx = gx + Math.round((gw - srcCW) / 2);
      const srcCy = gy + Math.round((gh - srcCH) / 2);
      const canvas = createCanvas(CARD_W, CARD_H);
      const ctx = canvas.getContext('2d');
      // imageSmoothingEnabled = true 让缩放平滑;源/目标区全整数避免亚像素
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, srcCx, srcCy, srcCW, srcCH, 0, 0, CARD_W, CARD_H);
      frames.push(await canvas.toJpegBytes());
    }
  }
  return frames;
}
