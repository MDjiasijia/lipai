/**
 * 天气展示层的纯函数 —— 不打网络。
 *
 * 取数把 wttr 的小时序列 / 天文存下来,渲染时按「此刻」再算 UV 和日照文案。
 * UV 一天里变好几档,冻在取数那一刻会让轮播一两个小时都显示中午的指数;
 * 日出日落也该跟着太阳走,不是永远并排写升+落。
 */

export interface UvSample {
  /** 从 00:00 起的分钟数(Open-Meteo 小时 ISO "2026-09-07T15:00" → 900)。 */
  minutes: number;
  uv: number;
}

export interface WeatherAstronomy {
  sunrise: string;
  sunset: string;
  moonPhase: string;
  moonIllumination: number;
}

export interface SunCardCopy {
  /** 卡片顶栏:日出 / 日落。 */
  label: string;
  emoji: string;
  /** 大数字:HH:mm。 */
  time: string;
  /** 月相,夜间日出预判会带「明日」。 */
  caption: string;
}

/** wttr.in weatherCode → 中文。码对得上就用这个,不信 lang_zh(经常仍是英文)。 */
export const WEATHER_CODE_CN: Record<string, string> = {
  '113': '晴',
  '116': '多云',
  '119': '阴',
  '122': '阴',
  '143': '雾',
  '176': '小雨',
  '179': '小雪',
  '182': '雨夹雪',
  '185': '雨夹雪',
  '200': '雷阵雨',
  '227': '小雪',
  '230': '大雪',
  '248': '雾',
  '260': '雾',
  '263': '小雨',
  '266': '中雨',
  '281': '雨夹雪',
  '284': '雨夹雪',
  '293': '小雨',
  '296': '中雨',
  '299': '大雨',
  '302': '中雨',
  '305': '大雨',
  '308': '暴雨',
  '311': '暴雨',
  '314': '大暴雨',
  '317': '雨夹雪',
  '320': '小雪',
  '323': '中雪',
  '326': '大雪',
  '329': '暴雪',
  '332': '暴雪',
  '335': '大暴雪',
  '338': '特大暴雪',
  '350': '雨夹雪',
  '353': '阵雨',
  '356': '阵雨',
  '359': '阵雨',
  '362': '阵雪',
  '365': '阵雪',
  '368': '小雪',
  '371': '大雪',
  '374': '雨夹雪',
  '377': '雨夹雪',
  '386': '雷阵雨',
  '389': '雷阵雨',
  '392': '雷阵雪',
  '395': '雷阵雪',
};

/** 码表没有时,把 wttr 英文描述翻成中文(lang=zh 经常仍吐英文)。 */
const DESC_EN_CN: Record<string, string> = {
  sunny: '晴',
  clear: '晴',
  'partly cloudy': '多云',
  cloudy: '多云',
  overcast: '阴',
  mist: '雾',
  fog: '雾',
  'freezing fog': '冻雾',
  'patchy rain nearby': '局部小雨',
  'patchy rain possible': '局部小雨',
  'patchy light rain': '小雨',
  'light rain': '小雨',
  'light rain shower': '小阵雨',
  'light drizzle': '小雨',
  'patchy light drizzle': '小雨',
  drizzle: '小雨',
  'moderate rain': '中雨',
  'moderate rain at times': '中雨',
  'moderate or heavy rain shower': '大阵雨',
  'heavy rain': '大雨',
  'heavy rain at times': '大雨',
  'torrential rain shower': '暴雨',
  'thundery outbreaks in nearby': '雷阵雨',
  'thundery outbreaks possible': '雷阵雨',
  'patchy light rain with thunder': '雷阵雨',
  'moderate or heavy rain with thunder': '雷暴雨',
  'light snow': '小雪',
  'patchy light snow': '小雪',
  'moderate snow': '中雪',
  'heavy snow': '大雪',
  blizzard: '暴风雪',
  'light sleet': '雨夹雪',
  'moderate or heavy sleet': '雨夹雪',
  'ice pellets': '冰雹',
};

function looksChinese(s: string): boolean {
  return /[一-鿿]/.test(s);
}

/** 天气描述 → 中文:先信 weatherCode,再信已是中文的文案,再翻英文,最后才原样回落。 */
export function descToCn(code: string, ...fallbacks: string[]): string {
  const fromCode = WEATHER_CODE_CN[code];
  if (fromCode) return fromCode;
  for (const raw of fallbacks) {
    const t = raw.trim();
    if (!t) continue;
    if (looksChinese(t)) return t;
    const mapped = DESC_EN_CN[t.toLowerCase()];
    if (mapped) return mapped;
  }
  return fallbacks.find((s) => s.trim())?.trim() ?? '';
}

/** "18:32" → 从 00:00 起的分钟;解析失败返回 null。 */
export function hhmmToMinutes(hhmm: string | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function nowMinutes(now: Date): number {
  return now.getHours() * 60 + now.getMinutes();
}

/**
 * 按此刻从小时 UV 序列取值。wttr 一档 3 小时,两点之间线性插值,
 * 这样轮播 30 秒换卡时指数会跟着太阳走,不用为了 UV 去打网络。
 * 没有样本返回 null(调用方回落 current.uvIndex)。
 */
export function uvAt(samples: readonly UvSample[] | undefined, now = new Date()): number | null {
  if (!samples?.length) return null;
  const sorted = [...samples]
    .filter((s) => Number.isFinite(s.uv))
    .sort((a, b) => a.minutes - b.minutes);
  if (!sorted.length) return null;
  const t = nowMinutes(now);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  if (t <= first.minutes) return first.uv;
  if (t >= last.minutes) return last.uv;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    if (t <= b.minutes) {
      const span = b.minutes - a.minutes;
      if (span <= 0) return b.uv;
      const w = (t - a.minutes) / span;
      return a.uv + (b.uv - a.uv) * w;
    }
  }
  return last.uv;
}

function moonCaption(astro: WeatherAstronomy, prefix?: string): string {
  const bits: string[] = [];
  if (prefix) bits.push(prefix);
  if (astro.moonPhase) bits.push(astro.moonPhase);
  if (astro.moonIllumination) bits.push(`${astro.moonIllumination}%`);
  return bits.join(' · ');
}

export interface WeatherPalette {
  bgA: string;
  bgB: string;
  fg: string;
  sub: string;
  accent: string;
}

export interface WeatherStyle {
  icon: string;
  palette: WeatherPalette;
  tempLabel: string;
}

/** 气温档只负责可读标签。背景色跟天空走,不当主色。 */
const TEMP_LABELS: { below: number; label: string }[] = [
  { below: -5, label: '严寒' },
  { below: 5, label: '寒冷' },
  { below: 14, label: '偏凉' },
  { below: 22, label: '舒适' },
  { below: 28, label: '温暖' },
  { below: 34, label: '炎热' },
  { below: Infinity, label: '酷热' },
];

export function tempLabelOf(tempC: number): string {
  return TEMP_LABELS.find((b) => tempC < b.below)?.label ?? '酷热';
}

/**
 * 天气状况 → emoji + 一套配色。
 * 主色跟天空走:晴是天蓝、雨是湿青、雷是紫、雪是冰蓝、雾是灰褐。
 * 匹配顺序要紧:雨夹雪 / 暴雨 / 雷 必须在泛「雨」之前,否则雷阵雨会画成普通雨。
 */
const CONDITION_STYLES: { test: (d: string) => boolean; icon: string; palette: WeatherPalette }[] =
  [
    {
      test: (d) => d.includes('晴'),
      icon: '☀️',
      palette: {
        bgA: '#3a9adf',
        bgB: '#0b3a6a',
        fg: '#fff8e8',
        sub: '#cfe8ff',
        accent: '#ffd56a',
      },
    },
    {
      test: (d) => d.includes('雨夹雪'),
      icon: '🌨️',
      palette: {
        bgA: '#5a88a8',
        bgB: '#142838',
        fg: '#eef7fc',
        sub: '#b4d0e0',
        accent: '#8ec4dc',
      },
    },
    {
      test: (d) => d.includes('暴雨') || d.includes('大雨'),
      icon: '⛈️',
      palette: {
        bgA: '#2a4a72',
        bgB: '#0a1224',
        fg: '#e8eef8',
        sub: '#9aadc8',
        accent: '#6a8ec4',
      },
    },
    {
      test: (d) => d.includes('雷'),
      icon: '⛈️',
      palette: {
        bgA: '#4a3a78',
        bgB: '#140c28',
        fg: '#f3eaff',
        sub: '#c4b0e8',
        accent: '#b48cff',
      },
    },
    {
      test: (d) => d.includes('雨'),
      icon: '🌧️',
      palette: {
        bgA: '#2f6f88',
        bgB: '#0a2430',
        fg: '#e8f6fb',
        sub: '#9ec9d8',
        accent: '#5ec4e0',
      },
    },
    {
      test: (d) => d.includes('暴雪') || d.includes('大雪'),
      icon: '❄️',
      palette: {
        bgA: '#8eb4d4',
        bgB: '#1e3348',
        fg: '#f7fcff',
        sub: '#d0e4f4',
        accent: '#e8f4ff',
      },
    },
    {
      test: (d) => d.includes('雪'),
      icon: '🌨️',
      palette: {
        bgA: '#7aa0c4',
        bgB: '#1a3048',
        fg: '#f5fbff',
        sub: '#c5d9ee',
        accent: '#d0e6ff',
      },
    },
    {
      test: (d) => d.includes('雾'),
      icon: '🌫️',
      palette: {
        bgA: '#7a7e72',
        bgB: '#2a2c28',
        fg: '#f2f1e8',
        sub: '#c6c5b8',
        accent: '#b8bca8',
      },
    },
    {
      test: (d) => d.includes('阴'),
      icon: '☁️',
      palette: {
        bgA: '#6b7380',
        bgB: '#1e232b',
        fg: '#eef1f4',
        sub: '#b8c0c8',
        accent: '#8a93a0',
      },
    },
    {
      test: (d) => d.includes('多云'),
      icon: '⛅',
      palette: {
        bgA: '#6a8aaa',
        bgB: '#1c3044',
        fg: '#f4f7fb',
        sub: '#c5d4e2',
        accent: '#9eb8d0',
      },
    },
  ];

const FALLBACK_CONDITION = {
  icon: '🌤️',
  palette: {
    bgA: '#4a90b8',
    bgB: '#16344c',
    fg: '#f4fbff',
    sub: '#b5d4e8',
    accent: '#7ec8e8',
  } satisfies WeatherPalette,
};

export function conditionStyle(descCn: string): { icon: string; palette: WeatherPalette } {
  return CONDITION_STYLES.find((s) => s.test(descCn)) ?? FALLBACK_CONDITION;
}

const TINT_COLD = '#1a3a6e';
const TINT_HOT = '#c45a18';

function mixHex(a: string, b: string, f: number): string {
  const n1 = Number.parseInt(a.slice(1), 16);
  const n2 = Number.parseInt(b.slice(1), 16);
  const to = (x: number, y: number) => Math.round(x * (1 - f) + y * f);
  const r = to((n1 >> 16) & 0xff, (n2 >> 16) & 0xff);
  const g = to((n1 >> 8) & 0xff, (n2 >> 8) & 0xff);
  const bl = to(n1 & 0xff, n2 & 0xff);
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`;
}

/** 气温只轻推冷暖,不当主色。热天的雨仍是湿青,只略偏暖;冷天的晴仍是天蓝,只略偏冷。 */
export function tintByTemp(p: WeatherPalette, tempC: number): WeatherPalette {
  let color = TINT_COLD;
  let amount = 0;
  if (tempC < 5) {
    amount = Math.min(0.26, (5 - tempC) / 22);
  } else if (tempC > 26) {
    color = TINT_HOT;
    amount = Math.min(0.26, (tempC - 26) / 16);
  }
  if (amount <= 0) return p;
  return {
    bgA: mixHex(p.bgA, color, amount),
    bgB: mixHex(p.bgB, color, amount * 0.7),
    fg: p.fg,
    sub: mixHex(p.sub, color, amount * 0.25),
    accent: mixHex(p.accent, color, amount * 0.35),
  };
}

/**
 * 天气状况 + 气温 → emoji + Palette + 温度标签。
 * 背景跟天空走,气温只做冷暖微调;预报卡用各自那天的状况,所以「明天会下雨」看颜色就知道。
 */
export function weatherStyle(descCn: string, tempC: number): WeatherStyle {
  const cond = conditionStyle(descCn);
  return {
    icon: cond.icon,
    tempLabel: tempLabelOf(tempC),
    palette: tintByTemp(cond.palette, tempC),
  };
}

/**
 * 日照卡文案:日落前讲今天几点落 + 月相;日落后讲下一场日出(今天还没出就用今日,
 * 已经落了用明日)。桌上看「下一件太阳的事」,不是把升和落并排写死。
 */
export function sunCardCopy(
  astro: WeatherAstronomy,
  opts: { tomorrowSunrise?: string | null; now?: Date } = {},
): SunCardCopy | null {
  const now = opts.now ?? new Date();
  const t = nowMinutes(now);
  const rise = hhmmToMinutes(astro.sunrise);
  const set = hhmmToMinutes(astro.sunset);

  if (set != null && t < set && (rise == null || t >= rise)) {
    if (!astro.sunset) return null;
    return {
      label: '日落',
      emoji: '🌇',
      time: astro.sunset,
      caption: moonCaption(astro),
    };
  }

  if (rise != null && t < rise && astro.sunrise) {
    return {
      label: '日出',
      emoji: '🌅',
      time: astro.sunrise,
      caption: moonCaption(astro),
    };
  }

  const next = opts.tomorrowSunrise?.trim() || astro.sunrise;
  if (!next) return null;
  return {
    label: '日出',
    emoji: '🌅',
    time: next,
    caption: moonCaption(astro, '明日'),
  };
}
