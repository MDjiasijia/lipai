/**
 * 天气卡片的语义 ID —— 前后端唯一真相。
 *
 * `renderWeatherCards` 渲出来的帧顺序是固定的(主卡 → 气温 → 湿度 → 风 → UV → 降水 →
 * 日照 → 明天 → 后天 → 补位概览),但其中 UV/降水/日照/预报天 是**有数据才出**的,每次取数
 * 实际渲出来的张数和组合都不一样。所以不能按下标认卡 —— 用稳定语义 ID 才能跨刷新/轮播
 * 对齐「同一张卡」。
 *
 * 存的是 ID 顺序(用户拖拽排的),重启后重新取数再按这份顺序排。数据是新的、顺序是你定的。
 * 和混合流(`mixed-cards.ts`)同一套思路,只是天气没有「排除」(所有出现的卡都推),
 * 只有顺序。
 */

/** 天气卡片稳定 ID(存进配置,不能改字面量)。 */
export type WeatherCardId =
  | 'main' // 主卡:城市 + emoji + 描述 + 温度
  | 'temp' // 气温
  | 'humidity' // 湿度
  | 'wind' // 风
  | 'uv' // 紫外线(有数据才出,夜里 0 也出)
  | 'precip' // 降水(有降雨量/概率才出)
  | 'sun' // 日照(日出/日落)
  | 'tomorrow' // 明天预报
  | 'day-after' // 后天预报
  | 'overview'; // 补位概览(不足 6 张时凑数,可能多张)

export interface WeatherCardDef {
  id: WeatherCardId;
  /** 卡片可读名(预览标签)。 */
  label: string;
}

/**
 * 卡片清单,数组顺序即定义/渲染顺序。
 * 这就是 `renderWeatherCards` 的 add 顺序 —— 加卡时两边都要改。
 *
 * 日照排在预报(明天/后天)之前:今天的事(降水/日出日落)比未来的事紧,
 * 6 张槽位挤不下时先挤掉的是后天,不是今天日落。
 */
export const WEATHER_CARD_DEFS: readonly WeatherCardDef[] = [
  { id: 'main', label: '主卡' },
  { id: 'temp', label: '气温' },
  { id: 'humidity', label: '湿度' },
  { id: 'wind', label: '风' },
  { id: 'uv', label: '紫外线' },
  { id: 'precip', label: '降水' },
  { id: 'sun', label: '日照' },
  { id: 'tomorrow', label: '明天' },
  { id: 'day-after', label: '后天' },
  { id: 'overview', label: '概览' },
];

/** 全部卡片 ID(定义顺序)。 */
export const WEATHER_CARD_IDS: readonly WeatherCardId[] = WEATHER_CARD_DEFS.map((c) => c.id);

/** ID → 可读名。 */
export function weatherCardLabel(id: string): string {
  return WEATHER_CARD_DEFS.find((c) => c.id === id)?.label ?? id;
}

/**
 * 把用户自定义的卡片顺序归一化成「本次实际出现的卡的合法顺序」。
 *
 * 和混合流的 `sanitizeMixedCardOrder` 同理,但天气的卡是**有数据才出现**的(UV/降水/日照/
 * 预报天),所以要传入「本次实际渲出来的 ID 列表」`present`:
 * - 只认 `present` 里有的 ID(本次没数据的卡不进顺序);
 * - 用户存过的顺序优先,没存过(或本次没出现)的按**定义顺序**补到末尾;
 * - 去重(补位概览可能多张,但顺序里只占一个位 —— 多张同名卡会聚在一起、保持内部顺序);
 * - 省略/空 order = 全用定义顺序(等价于没拖过)。
 *
 * @param order 存盘的顺序(用户拖过的);空/省略 = 没拖过
 * @param present 本次实际渲出来的卡片 ID(按出现顺序,可能含重复的 overview)
 * @returns `present` 重排后的顺序(长度与 present 相同,含所有本次的卡)
 */
export function sanitizeWeatherCardOrder(
  order: readonly string[] | null | undefined,
  present: readonly WeatherCardId[],
): WeatherCardId[] {
  // 用户存过的顺序,去掉本次没出现的、去重
  const presentSet = new Set<WeatherCardId>(present);
  const ordered: WeatherCardId[] = [];
  const seen = new Set<WeatherCardId>();
  for (const id of order ?? []) {
    if (!WEATHER_CARD_IDS.includes(id as WeatherCardId)) continue;
    const wId = id as WeatherCardId;
    if (!presentSet.has(wId) || seen.has(wId)) continue;
    seen.add(wId);
    ordered.push(wId);
  }
  // 没存过顺序的(或本次没出现的)按定义顺序补 —— 补位概览(overview)在定义里已是末尾
  for (const id of WEATHER_CARD_IDS) {
    if (!presentSet.has(id) || seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  // overview 可能有多张:上面只放了一个,把多出来的补到末尾(聚在一起)
  const overviewCount = present.filter((id) => id === 'overview').length;
  for (let i = 1; i < overviewCount; i++) ordered.push('overview');
  return ordered;
}

/**
 * 按一份顺序重排实际渲出来的卡片数组(稳定排序:同 ID 的卡保持原相对顺序)。
 *
 * `order` 通常是 `sanitizeWeatherCardOrder(...)` 的结果。没在 order 里的卡(不该发生,
 * sanitize 已含全部 present)按原顺序排到末尾。
 */
export function applyWeatherCardOrder<T extends { id: string }>(
  cards: readonly T[],
  order: readonly WeatherCardId[],
): T[] {
  const pos = new Map<string, number>();
  order.forEach((id, i) => {
    if (!pos.has(id)) pos.set(id, i); // 同 ID 取第一个位置,其余卡排其后(稳定)
  });
  const fallback = order.length;
  return [...cards].sort((a, b) => {
    const pa = pos.get(a.id) ?? fallback;
    const pb = pos.get(b.id) ?? fallback;
    if (pa !== pb) return pa - pb;
    return 0; // 稳定:同 ID 保持原顺序(JS sort 稳定)
  });
}

/**
 * 一步到位:把本次实际渲出来的卡按存盘顺序排好(= sanitize + apply)。
 *
 * 四条路径(投屏预览 / 推槽位 / 轮播 / 配置列表缩略图)都只调这一个 —— 顺序这件事只有
 * 一个入口,新加一条取卡路径时不会漏掉排序,也不用各自算 `present`。
 *
 * @param cards `renderWeatherCards` 的结果(按渲染定义顺序)
 * @param order 存盘的顺序(`SlotSpec.weatherCardOrder`);空/省略 = 没拖过,原样返回
 */
export function orderWeatherCards<T extends { id: WeatherCardId }>(
  cards: readonly T[],
  order: readonly string[] | null | undefined,
): T[] {
  if (!order?.length) return [...cards];
  return applyWeatherCardOrder(
    cards,
    sanitizeWeatherCardOrder(
      order,
      cards.map((c) => c.id),
    ),
  );
}
