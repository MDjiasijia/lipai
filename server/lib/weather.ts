/**
 * 天气服务:用 Open-Meteo 查真实天气(免 Key,支持中文城市名),
 * fetch 用 Node 22+ 全局版。
 * + 常用中国城市 → QWeather Location ID 映射(给设备原生天气用)。
 *
 * 2026-09 从 wttr.in 换源:wttr 后端是 WorldWeatherOnline,对中国城市经常不准
 * (实测晴天报「零星降雨」);Open-Meteo 是多模式融合(含中国气象局 CMA 模式),
 * 免 Key、geocoding 支持中文城市名,能见度/气压/降水概率/风向全有。
 * 月相 Open-Meteo 不提供,本地天文算法算。
 */
import type { UvSample, WeatherAstronomy } from './weather-view.js';

export type { UvSample, WeatherAstronomy };

/** 当前天气(保持 wttr 时代的形状,渲染层零改动)。 */
export interface CurrentWeather {
  city: string;
  tempC: number;
  feelsLikeC: number;
  humidity: number;
  windKmh: number;
  windDir: string;
  desc: string;
  descCn: string;
  visibility: number;
  pressure: number;
  precipMm: number;
  uvIndex: number;
}

/** 预报(精简,3 天)。 */
export interface WeatherForecast {
  date: string;
  maxTempC: number;
  minTempC: number;
  desc: string;
  descCn: string;
}

export interface WeatherResult {
  current: CurrentWeather;
  forecast: WeatherForecast[];
  astronomy: WeatherAstronomy | null;
  /** 明日日出(HH:mm),日落后的日照卡用来预告下一场日出。 */
  tomorrowSunrise?: string | null;
  chanceOfRain: number | null;
  /**
   * 今日小时 UV 序列。渲染时按此刻插值,不把取数那一档冻进 current.uvIndex ——
   * UV 一天变好几档,缓存窗口一两个小时会让立牌一直显示中午的指数。
   */
  uvHourly?: UvSample[];
  /** 取数时刻(ms)。主卡注脚显示「几号几点查的」—— 缓存命中时它比渲染时刻早,
   *  如实显示而不是假装刚查的。0/缺失 = 渲层回落当前时刻。 */
  fetchedAt?: number;
}

interface CacheEntry {
  result: WeatherResult;
  at: number;
}

/**
 * 天气结果缓存(城市 → 结果 + 时间戳)。
 * 一是同城市反复刷新不必每次打网络,二是配置列表要给天气来源渲缩略图 ——
 * 那里只读缓存、不发请求(渲个缩略图不该卡在网络上)。
 *
 * 缩略图 / 默认 getWeather:2 小时内复用。wttr.in 自己也就小时级更新,
 * 再密只是白打请求。
 */
export const CACHE_TTL_MS = 2 * 60 * 60 * 1000;
/** 轮播默认新鲜度:1 小时。可由 loopWeatherRefreshMin 覆盖。 */
export const WEATHER_FRESH_MS = 60 * 60 * 1000;

const weatherCache = new Map<string, CacheEntry>();

/** Open-Meteo 预报响应(精简,只声明用到的字段)。 */
interface OmResponse {
  current: {
    time: string;
    temperature_2m: number;
    apparent_temperature: number;
    relative_humidity_2m: number;
    weather_code: number;
    wind_speed_10m: number;
    wind_direction_10m: number;
    surface_pressure: number;
    precipitation: number;
    uv_index?: number;
  };
  hourly: {
    time: string[];
    weather_code: number[];
    uv_index: number[];
    visibility?: number[];
    precipitation_probability?: number[];
  };
  daily: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    sunrise: string[];
    sunset: string[];
  };
}

/** WMO 4677 天气码 → 中文(Open-Meteo 用这套;渲染按文案里的「晴/雨/雪/雾/雷/阴/多云」选样式)。 */
const WMO_CODE_CN: Record<number, string> = {
  0: '晴',
  1: '基本晴',
  2: '多云',
  3: '阴',
  45: '雾',
  48: '冻雾',
  51: '毛毛雨',
  53: '毛毛雨',
  55: '浓毛毛雨',
  56: '冻毛毛雨',
  57: '浓冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '阵雨',
  81: '强阵雨',
  82: '暴雨',
  85: '阵雪',
  86: '强阵雪',
  95: '雷雨',
  96: '雷雨伴冰雹',
  99: '强雷雨伴冰雹',
};

function wmoCn(code: number | undefined): string {
  return (code !== undefined && WMO_CODE_CN[code]) || '未知';
}

/** 风向度数 → 16 方位缩写(与渲染层 WIND_DEG 同一套键)。 */
const COMPASS_16 = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
] as const;

function degToCompass(deg: number): string {
  return COMPASS_16[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]!;
}

/**
 * 本地月相近似(Meeus 简化朔望周期):Open-Meteo 不提供月相/照明度。
 * 精度对「立牌角落一行月相文案」足够(相位分八档,照明度 ±5%)。
 */
function moonPhaseAt(date: Date): { phase: string; illumination: number } {
  const SYNODIC = 29.530588853; // 朔望月天数
  const NEW_MOON_EPOCH = Date.UTC(2000, 0, 6, 18, 14); // 2000-01-06 18:14 UTC 新月
  const frac =
    (((((date.getTime() - NEW_MOON_EPOCH) / 86400000) % SYNODIC) + SYNODIC) % SYNODIC) / SYNODIC;
  const illumination = Math.round(((1 - Math.cos(2 * Math.PI * frac)) / 2) * 100);
  const PHASES: readonly [number, string][] = [
    [0.03, '新月'],
    [0.22, '蛾眉月'],
    [0.28, '上弦月'],
    [0.47, '盈凸月'],
    [0.53, '满月'],
    [0.72, '亏凸月'],
    [0.78, '下弦月'],
    [0.97, '残月'],
    [1.01, '新月'],
  ];
  return { phase: PHASES.find(([lim]) => frac < lim)?.[1] ?? '新月', illumination };
}

/** 城市名 → 经纬度缓存(geocoding):坐标不变,缓存 24h;网络失败回落旧值。 */
const geoCache = new Map<string, { at: number; lat: number; lon: number }>();
const GEO_TTL_MS = 24 * 60 * 60 * 1000;

async function geocode(city: string): Promise<{ lat: number; lon: number }> {
  const key = city.trim();
  const hit = geoCache.get(key);
  if (hit && Date.now() - hit.at < GEO_TTL_MS) return { lat: hit.lat, lon: hit.lon };
  try {
    const res = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(key)}&count=1&language=zh&format=json`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      results?: { latitude: number; longitude: number }[];
    };
    const r = data.results?.[0];
    if (!r) throw new Error(`没找到城市「${key}」`);
    geoCache.set(key, { at: Date.now(), lat: r.latitude, lon: r.longitude });
    return { lat: r.latitude, lon: r.longitude };
  } catch (err) {
    // 网络失败/没找到:回落缓存里的旧坐标(哪怕过期) —— 天气取数还能继续
    if (hit) return { lat: hit.lat, lon: hit.lon };
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** 取缓存里的天气(超过 maxAgeMs / 没有则 null),不发请求。 */
export function getCachedWeather(city: string, maxAgeMs = CACHE_TTL_MS): WeatherResult | null {
  const hit = weatherCache.get(city.trim());
  if (!hit) return null;
  if (Date.now() - hit.at > maxAgeMs) {
    // 只在按默认 TTL 判过期时才清掉:调用方要求更严的新鲜度(轮播)不该顺手
    // 把还在 TTL 内、缩略图能用的缓存删了。maxAgeMs=0(强制刷新)也不清。
    if (maxAgeMs >= CACHE_TTL_MS) weatherCache.delete(city.trim());
    return null;
  }
  return hit.result;
}

/**
 * 查询 Open-Meteo 天气(免 Key,支持中文城市名)。默认 2 小时内同城市走缓存。
 * @param opts.maxAgeMs 能接受的缓存年龄上限;轮播传可配的新鲜度窗口。
 *   传 0 强制打网络,但不清掉现有缓存(失败时调用方仍能读到上一份)。
 */
export async function getWeather(
  city: string,
  opts: { maxAgeMs?: number } = {},
): Promise<WeatherResult> {
  const cached = getCachedWeather(city, opts.maxAgeMs);
  if (cached) return cached;
  const { lat, lon } = await geocode(city);
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,' +
    'wind_speed_10m,wind_direction_10m,surface_pressure,precipitation,uv_index' +
    '&hourly=weather_code,uv_index,visibility,precipitation_probability' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset' +
    '&forecast_days=3&timezone=auto';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo 查询失败:HTTP ${res.status}`);
  const data = (await res.json()) as OmResponse;

  const cur = data.current;
  const cn = wmoCn(cur.weather_code);
  // 当前小时在 hourly 序列里的下标(本地时区;timezone=auto 已对齐)
  const nowPrefix = cur.time.slice(0, 13);
  const hourIdx = Math.max(
    0,
    data.hourly.time.findIndex((t) => t.slice(0, 13) === nowPrefix),
  );

  const current: CurrentWeather = {
    city,
    tempC: cur.temperature_2m,
    feelsLikeC: cur.apparent_temperature,
    humidity: cur.relative_humidity_2m,
    windKmh: cur.wind_speed_10m,
    windDir: degToCompass(cur.wind_direction_10m),
    desc: cn,
    descCn: cn,
    // 能见度米 → km(wttr 时代就是 km,渲染层按 km 显示)
    visibility: (data.hourly.visibility?.[hourIdx] ?? 0) / 1000,
    pressure: cur.surface_pressure,
    precipMm: cur.precipitation,
    uvIndex: cur.uv_index ?? data.hourly.uv_index[hourIdx] ?? 0,
  };

  const forecast: WeatherForecast[] = data.daily.time.slice(0, 3).map((date, i) => {
    const cn2 = wmoCn(data.daily.weather_code[i]);
    return {
      date,
      maxTempC: data.daily.temperature_2m_max[i] ?? 0,
      minTempC: data.daily.temperature_2m_min[i] ?? 0,
      desc: cn2,
      descCn: cn2,
    };
  });

  // 天文:Open-Meteo 有日出日落;月相本地算
  const moon = moonPhaseAt(new Date());
  const astronomy: WeatherAstronomy | null =
    data.daily.sunrise[0] || data.daily.sunset[0]
      ? {
          sunrise: data.daily.sunrise[0]?.slice(11, 16) ?? '',
          sunset: data.daily.sunset[0]?.slice(11, 16) ?? '',
          moonPhase: moon.phase,
          moonIllumination: moon.illumination,
        }
      : null;

  const result: WeatherResult = {
    current,
    forecast,
    astronomy,
    tomorrowSunrise: data.daily.sunrise[1]?.slice(11, 16) || null,
    chanceOfRain: data.hourly.precipitation_probability?.[hourIdx] ?? null,
    // 全序列 UV(渲染时按此刻插值):分钟数从 hourly ISO 时间算
    uvHourly: data.hourly.time.map((t, i) => ({
      minutes: Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16)),
      uv: data.hourly.uv_index[i] ?? 0,
    })),
    fetchedAt: Date.now(),
  };
  weatherCache.set(city.trim(), { at: Date.now(), result });
  return result;
}

/**
 * 常用中国城市 → QWeather Location ID 映射(给设备原生天气用)。
 * QWeather Location ID 是 9-12 位数字(如北京 101010100)。
 * 设备拿这个 ID 自己去查天气(若设备服务正常)。
 */
export const CITY_TO_LOCATION_ID: Record<string, string> = {
  北京: '101010100',
  上海: '101020100',
  广州: '101280101',
  深圳: '101280601',
  杭州: '101210101',
  南京: '101190101',
  苏州: '101190401',
  成都: '101270101',
  重庆: '101040100',
  武汉: '101200101',
  西安: '101110101',
  天津: '101030100',
  青岛: '101120201',
  长沙: '101250101',
  郑州: '101180101',
  合肥: '101220101',
  福州: '101230101',
  厦门: '101230201',
  哈尔滨: '101050101',
  沈阳: '101070101',
  大连: '101070201',
  长春: '101060101',
  太原: '101100101',
  石家庄: '101090101',
  济南: '101120101',
  南昌: '101240101',
  昆明: '101290101',
  贵阳: '101260101',
  兰州: '101160101',
  银川: '101170101',
  西宁: '101150101',
  拉萨: '101140101',
  海口: '101310101',
  三亚: '101310201',
  南宁: '101300101',
  呼和浩特: '101080101',
  乌鲁木齐: '101130101',
};

/** 城市名 → QWeather Location ID。找不到返回 null(设备可能支持直接用城市名)。 */
export function cityToLocationId(city: string): string | null {
  return CITY_TO_LOCATION_ID[city.trim()] ?? null;
}

/** 列出所有支持的城市名(给 webview 下拉用)。 */
export function listCities(): string[] {
  return Object.keys(CITY_TO_LOCATION_ID);
}
