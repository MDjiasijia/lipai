/**
 * 跟光镜边高光（liquid-glass-react 的 border-follows-mouse 技法，全局事件委托版）。
 *
 * CSS 侧（index.css @utility glass-spotlight）读 --mx/--my 出一束跟着指针的光；
 * 这里只需要在全局 pointermove 时把指针位置写进命中的 .glass-spotlight 元素 ——
 * 一份监听器服务全站，不逐元素挂/卸（弹层动态出现也不漏）。
 *
 * 事件模型选择：pointermove 而非 mousemove —— 触屏拖动时光也跟着走，
 * 且 (hover:none) 媒体查询已在 CSS 侧把触屏退化为常亮顶光。
 * 性能：getBoundingClientRect 只在命中的瞬间调一次/帧（事件本身已节流到帧），
 * 写 CSS 变量不触发 layout（radial-gradient 重绘由合成器承担）。
 * reduced-motion / reduced-transparency：CSS 侧已有闸门，这里不重复判。
 */
export function mountSpotlight(): void {
  document.addEventListener('pointermove', (e) => {
    // 命中检查：事件目标到根之间找最近的 .glass-spotlight（弹层内容也在内）
    const target = (e.target as Element | null)?.closest?.('.glass-spotlight')
    if (!(target instanceof HTMLElement)) return
    const rect = target.getBoundingClientRect()
    // 指针在元素内的百分比位置；元素外（box-shadow 范围）clamp 到 0-100
    const mx = ((e.clientX - rect.left) / rect.width) * 100
    const my = ((e.clientY - rect.top) / rect.height) * 100
    target.style.setProperty('--mx', `${Math.round(Math.min(100, Math.max(0, mx)))}%`)
    target.style.setProperty('--my', `${Math.round(Math.min(100, Math.max(0, my)))}%`)
  })
}
