/**
 * base64 帧 → data URL。
 * 从原 components/Simulator.tsx 迁出（该组件已下线，仅 frameUrl 仍被 NixieTube / Home 引用）。
 * 直接拼接，不做缓存：base64 串本身就是值，Map 里再存一份完整 data URL 是双倍内存，
 * 且帧字符串在记录级复用（同一 base64 引用传进来），拼接开销可忽略。
 */

export function frameUrl(b64: string): string {
  return `data:image/jpeg;base64,${b64}`
}
