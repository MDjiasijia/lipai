/**
 * 浏览器 canvas 适配层：给从上游扩展版移植的渲染器（canvas-kit / render / sprite）
 * 提供与 @napi-rs/canvas 等价的接缝。
 *
 * 双环境（主线程 / 渲染 Worker）：Worker 侧没有 document —— createCanvas 走
 * OffscreenCanvas、loadImage 走 createImageBitmap（Worker 无 DOM Image）；
 * 主线程保持 DOM canvas（Safari 的 OffscreenCanvas drawImage/字体兼容性差）。
 * 两个环境返回同一形状（ImageLike：有 width/height 可 drawImage）。
 *
 * 差异（napi → 浏览器）：
 * - toBuffer('image/jpeg', 92)：toBlob / convertToBlob → arrayBuffer（异步；
 *   napi 是同步的，所以 frame() 在这里变成 async —— 调用方全部 await）。
 * - 字体：napi 要 GlobalFonts.registerFromPath 注册 emoji/CJK；浏览器直接用
 *   系统字体栈（canvas-kit 的 EMOJI_FONT/FONT_CN 在这里变成 CSS font-family 栈）。
 */

export interface BrowserCanvas {
  readonly width: number
  readonly height: number
  getContext(type: '2d'): Ctx2D
  /** JPEG 编码（质量对齐 napi 的 92）；JPEG 不支持透明 → alpha 已由渲染器铺底 */
  toJpegBytes(quality?: number): Promise<Uint8Array>
}

/** 当前是否运行在 Worker 作用域（无 document 有 OffscreenCanvas）。 */
function isWorkerScope(): boolean {
  return typeof document === 'undefined' && typeof OffscreenCanvas !== 'undefined'
}

/** 渲染器签名统一用 DOM 2D 上下文类型（超集）；Worker 分叉处的
 *  OffscreenCanvasRenderingContext2D 在类型层收窄成它 —— 渲染器只用
 *  两个环境共有的 API（fillText/drawImage/渐变…），运行时零差异。 */
type Ctx2D = CanvasRenderingContext2D

export function createCanvas(width: number, height: number): BrowserCanvas {
  if (isWorkerScope()) {
    const el = new OffscreenCanvas(width, height)
    return {
      width,
      height,
      getContext: (type) => el.getContext(type) as unknown as Ctx2D,
      toJpegBytes: async (quality = 0.92) => {
        const blob = await el.convertToBlob({ type: 'image/jpeg', quality })
        return new Uint8Array(await blob.arrayBuffer())
      },
    }
  }
  const el = document.createElement('canvas')
  el.width = width
  el.height = height
  return {
    width,
    height,
    getContext: (type) => el.getContext(type) as Ctx2D,
    toJpegBytes: async (quality = 0.92) => {
      const blob = await new Promise<Blob | null>((resolve) =>
        el.toBlob(resolve, 'image/jpeg', quality),
      )
      if (!blob) throw new Error('canvas JPEG 编码失败')
      return new Uint8Array(await blob.arrayBuffer())
    },
  }
}

/** 加载图片（data URL / http(s) URL）；Worker 里走 createImageBitmap。 */
export async function loadImage(src: string): Promise<ImageLike> {
  if (isWorkerScope()) {
    const resp = await fetch(src)
    const bitmap = await createImageBitmap(await resp.blob())
    return bitmap
  }
  const img = new Image()
  img.decoding = 'async'
  img.src = src
  await img.decode()
  return img
}

/** base64（无 data: 前缀）→ data URL，loadImage 配套 */
export function b64ToDataUrl(b64: string, mime = 'image/jpeg'): string {
  return `data:${mime};base64,${b64}`
}

/** 渲染层通用的「可画图片」形状：可 drawImage 进 2D 上下文（HTMLImageElement /
 *  ImageBitmap 都满足；交叉 CanvasImageSource 让 TS 接受传给 drawImage）。 */
export type ImageLike = {
  width: number
  height: number
} & CanvasImageSource

/** 从原始字节加载（napi loadImage(Buffer) 的等价物）。 */
export async function loadImageFromBytes(bytes: Uint8Array): Promise<ImageLike> {
  const blob = new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' })
  if (isWorkerScope()) {
    return createImageBitmap(blob)
  }
  const url = URL.createObjectURL(blob)
  try {
    return await loadImage(url)
  } finally {
    // decode() 完成后字节已进解码器，revoke 不影响已显示图像
    URL.revokeObjectURL(url)
  }
}

/** 自动识别来源加载：data:/http(s):/blob: 直接加载，其余按 base64（无前缀）处理 */
export async function loadImageAuto(src: string): Promise<ImageLike> {
  if (src.startsWith('data:') || src.startsWith('http:') || src.startsWith('https:') || src.startsWith('blob:')) {
    return loadImage(src)
  }
  return loadImage(b64ToDataUrl(src))
}
