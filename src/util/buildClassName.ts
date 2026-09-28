/**
 * className 合并：falsy 项自动剔除 —— 条件类名不再写三元串。
 *   buildClassName('btn', isPrimary && 'btn-primary', className)
 */
type Parts = (string | false | undefined | null)[]

export default function buildClassName(...parts: Parts): string {
  return parts.filter(Boolean).join(' ')
}
