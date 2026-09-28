/**
 * 场景日程时段时间冲突判定 —— 前后端共享。
 *
 * 两个时段「撞车」= 开始时刻相同 **且** 生效星期有交集。
 * 只看时刻全等(不看 durationMin 重叠 —— 那是另一个维度,且 durationMin 到期会切回默认,
 * 短时段套在长时段里是合理的);星期交集保证「工作日 12:00」和「周末 12:00」不冲突
 * (日期不重叠),而「工作日 12:00」和「每天 12:00」冲突。
 *
 * 省略/空 daysOfWeek = 每天 [0,1,2,3,4,5,6]。
 */
import type { SceneSlot } from './profile-types.js';

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** 规范化 daysOfWeek:省略/空 → 每天。 */
function daysSet(days?: number[]): Set<number> {
  return new Set(days?.length ? days : ALL_DAYS);
}

/**
 * 新时段(time + daysOfWeek)是否与已有 slots 里某个撞车。
 * @param slots 已有时段列表
 * @param time 待判定的开始时刻 "HH:MM"
 * @param excludeId 排除自身的 id(编辑时传,避免和自己比)
 * @param daysOfWeek 待判定的生效星期;省略/空 = 每天
 */
export function hasTimeConflict(
  slots: readonly SceneSlot[],
  time: string,
  excludeId?: string,
  daysOfWeek?: number[],
): boolean {
  const newDays = daysSet(daysOfWeek);
  return slots.some((s) => {
    if (s.id === excludeId) return false;
    if (s.time !== time) return false;
    // 两边星期有交集才算撞车(工作日 ∩ 周末 = 空 → 不冲突)
    const other = daysSet(s.daysOfWeek);
    for (const d of newDays) if (other.has(d)) return true;
    return false;
  });
}
