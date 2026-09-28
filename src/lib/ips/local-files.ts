/**
 * 本地图片 → 135×240 帧裁剪（Web 版）。
 * 原版在 webview 里由用户选文件 → 后端裁；Web 版全在浏览器：
 * 选文件 → loadImageFromBytes → cover 裁剪 → JPEG base64（存进配方 frames 字段）。
 */
import { loadImageFromBytes, createCanvas } from './render/canvas-adapter'

export const CARD_W = 135
export const CARD_H = 240

/** 单个本地图片文件 → 裁剪后的 135×240 JPEG base64（无 data: 前缀） */
export async function cropLocalImage(
  file: File,
): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const img = await loadImageFromBytes(bytes)
  const canvas = createCanvas(CARD_W, CARD_H)
  const ctx = canvas.getContext('2d')
  const targetRatio = CARD_W / CARD_H
  const srcRatio = img.width / img.height
  let sx = 0
  let sy = 0
  let cropW = img.width
  let cropH = img.height
  if (srcRatio > targetRatio) {
    cropW = img.height * targetRatio
    sx = (img.width - cropW) / 2
  } else {
    cropH = img.width / targetRatio
    sy = (img.height - cropH) / 2
  }
  ctx.drawImage(img, sx, sy, cropW, cropH, 0, 0, CARD_W, CARD_H)
  const out = await canvas.toJpegBytes()
  // Uint8Array → base64
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < out.length; i += chunk) {
    binary += String.fromCharCode(...out.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** 字节 → base64（无 data: 前缀；蓝牙 sendImage 收 Uint8Array，配方存 base64） */
export function bytesToB64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** base64 → 字节（配方 frames 字段 → sendImage 的 Uint8Array[]） */
export function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}
