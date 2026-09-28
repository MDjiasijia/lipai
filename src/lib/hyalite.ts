/**
 * hyalite 液态玻璃挂载（src/lib 层，main.tsx 调用一次）。
 *
 * Chromium 下对 .glass/.card/.glass-chrome 元素挂真实折射（SDF 位移图 + SVG 滤镜 +
 * backdrop-filter: var(--hyalite)）；Safari/Firefox 不支持 SVG 背景滤镜，
 * Hyalite 挂载直接跳过，CSS 回落 blur(var(--glass-blur)) 继续生效 ——
 * 不支持的浏览器零代价，支持的浏览器白得一层「边缘把背景拉弯」的质感。
 *
 * blur 6 = CSS blur(12px)（SVG stdDeviation 是 CSS 半径的一半）—— 与 CSS 回落
 * 同霜深：同一块面板在 Chromium 和 Safari 里是同一种材质，只有折射掉档。
 * 门禁：降透明度偏好走 CSS 实底阶梯（index.css），这里不挂；降动效偏好关
 * materialize 渐起（折射仍生效，只是不再做入场动画）。
 */
type HyaliteGlobal = {
  supported: () => boolean
  watch: (
    container: Element | Document,
    selector: string,
    opts?: Record<string, unknown>,
  ) => { stop: () => void }
}

export function mountHyalite(): void {
  const H = (window as Window & { Hyalite?: HyaliteGlobal }).Hyalite
  if (!H || !H.supported()) return // 不支持的浏览器走 CSS 回落，不挂
  const reduced = window.matchMedia('(prefers-reduced-transparency: reduce)').matches
  if (reduced) return // 降透明度偏好：CSS 侧已换实底，不挂折射
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  try {
    H.watch(document.body, '.glass, .card, .glass-chrome', {
      bevel: 16,
      thickness: 10,
      blur: 6,
      // 色差（chromatic aberration）：位移折射的通道错位强度。
      // liquid-glass-react 用三次 feDisplacementMap 做 R/G/B 错位；
      // hyalite 一个旋钮等价 —— 0.05 太轻看不出虹彩，0.09 边缘可见但不脏。
      dispersion: 0.09,
      rim: 0.45,
      materialize: calm ? 0 : 240,
    })
  } catch {
    // 挂载失败（极端：CSP 拦 img-src data: 等）→ 静默回落 CSS blur
  }
}
