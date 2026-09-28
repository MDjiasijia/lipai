/**
 * 画布文案 + 配色生成(从 index.ts 提取的纯数据 + 纯函数)。
 *
 * generateCanvasTextsImpl / generateCanvasColorsImpl 供 exposes 方法调用,
 * 主题匹配 → 随机选一组 / 插值生成 10 组。
 */

/** 画布文案库(主题 → 多组 10 句文案)。 */
const CANVAS_TEXT_LIBRARY: Record<string, string[][]> = {
  打工人日常: [
    [
      '起床好困',
      '又要搬砖',
      '咖啡续命',
      '摸鱼快乐',
      '等下班',
      '肚子饿了',
      '需求又改',
      '心态崩了',
      '下班万岁',
      '终于周五',
    ],
    [
      '不想上班',
      '困到模糊',
      '通勤地狱',
      '等下班',
      '摸鱼快乐',
      '准备跑路',
      '明天再说',
      '硬撑到底',
      '周末见',
      '睡到自然醒',
    ],
    [
      '周一综合症',
      '忙到飞起',
      '需求又改',
      '心态崩了',
      '咖啡续命',
      '摸鱼快乐',
      '等下班',
      '下班万岁',
      '终于周五',
      '睡到自然醒',
    ],
  ],
  猫猫语录: [
    [
      '喵呜~',
      '别摸我',
      '要罐罐',
      '咕噜咕噜',
      '困了睡',
      '跳上桌',
      '踩键盘',
      '推杯子',
      '装无辜',
      '铲屎去',
    ],
    [
      '这是我的',
      '别烦我',
      '要罐罐',
      '咕噜咕噜',
      '跳上桌',
      '踩键盘',
      '推杯子',
      '装无辜',
      '别摸我',
      '铲屎去',
    ],
  ],
  早安问候: [
    [
      '早安呀',
      '今天也要',
      '元气满满',
      '加油哦',
      '会更好',
      '微笑面对',
      '新的一天',
      '阳光正好',
      '努力前行',
      '遇见美好',
    ],
    [
      '新的一天',
      '阳光正好',
      '微风不燥',
      '心怀期待',
      '努力前行',
      '遇见美好',
      '早安呀',
      '元气满满',
      '加油哦',
      '微笑面对',
    ],
  ],
  深夜emo: [
    [
      '又熬夜',
      '睡不着',
      '想太多',
      '夜太长',
      '一个人',
      '凌晨两点',
      '还在刷手机',
      '明明很困',
      '晚安世界',
      '明天会好',
    ],
    [
      '凌晨两点',
      '还在刷手机',
      '明明很困',
      '就是不想睡',
      '想太多',
      '夜太长',
      '一个人',
      '又熬夜',
      '晚安世界',
      '明天会好',
    ],
  ],
  干饭人: [
    [
      '饿了么',
      '吃啥呢',
      '点外卖',
      '加个鸡腿',
      '吃饱再说',
      '真香',
      '干饭时间',
      '今日菜单',
      '麻辣烫',
      '奶茶续命',
    ],
    [
      '干饭时间',
      '今日菜单',
      '麻辣烫',
      '奶茶续命',
      '再来一碗',
      '吃撑了',
      '饿了么',
      '加个鸡腿',
      '吃饱再说',
      '真香',
    ],
  ],
  疯狂星期四: [
    ['今天', '星期四', '有人', '请我', '吃', 'KFC', '吗', 'V我50', '谢谢', '老板'],
    ['疯狂', '星期四', 'V我', '50', '不多', '不少', '刚好', '一份', '全家桶', '拜托了'],
    ['星期四', '文学', '开始', '发作', '有没有', '好心人', '带我', '吃', '肯德基', '磕头了'],
  ],
  摆烂中: [
    ['不想干', '摆烂了', '爱谁谁', '躺平', '随便吧', '摸了', '算了', '明天再说', '下班', '溜了'],
    [
      '已读乱回',
      '在忙',
      '假装很忙',
      '摸鱼中',
      '划水',
      '别找我',
      '装死',
      '休眠中',
      '勿扰',
      '重启失败',
    ],
  ],
  发疯文学: [
    [
      '啊啊啊啊',
      '救命',
      '要疯了',
      '不干了',
      '哈哈哈',
      '我没事',
      '真的没事',
      '就是想叫',
      '啊——',
      '好了',
    ],
    [
      '为什么',
      '凭什么',
      '怎么会',
      '不可能',
      '再说一遍',
      '我不听',
      '啊啊啊',
      '算了',
      '摆烂',
      '睡觉',
    ],
  ],
  老板画饼: [
    ['年轻人', '要有', '拼劲', '公司', '就是', '你家', '期权', '很值钱', '明年', '上市'],
    ['先干', '再说', '格局', '打开', '拥抱', '变化', '狼性', '文化', '加油', '奥利给'],
  ],
  今天星期几: [
    ['周一', '如上坟', '周二', '还早', '周三', '一半了', '周四', 'KFC', '周五', '解放'],
    ['还有', '四天', '三天', '两天', '一天', '到周末', '坚持', '一下', '快到了', '冲'],
  ],
  发工资了: [
    ['工资', '到账', '瞬间', '暴富', '先还', '花呗', '然后', '归零', '下个月', '再说'],
    ['月初', '富哥', '月中', '正常', '月底', '吃土', '再等', '几天', '就发', '工资了'],
  ],
  早八人: [
    ['闹钟', '响了', '再睡', '五分钟', '完蛋', '迟到了', '飞奔', '打卡', '成功', '瘫倒'],
    ['起不来', '真起不来', '再躺', '一下', '就一下', '睡过了', '算了', '请假', '不请', '冲'],
  ],
  晚安世界: [
    ['忙完了', '洗个澡', '躺下', '刷手机', '再看', '一集', '就一集', '凌晨了', '完蛋', '晚安'],
    ['今天', '也', '辛苦了', '早点', '休息', '好梦', '明天', '会更好', '晚安', '世界'],
  ],
  恭喜发财: [
    ['新年', '快乐', '恭喜', '发财', '身体', '健康', '暴富', '暴瘦', '万事', '如意'],
    ['好运', '连连', '财源', '广进', '心想', '事成', '一切', '顺利', '大吉', '大利'],
  ],
  社恐日常: [
    ['别叫我', '别看我', '不想说话', '装忙', '低头', '快走', '躲开了', '松了口气', '好累', '回家'],
    ['电话', '不接', '语音', '不听', '打字', '可以', '见面', '不行', '社恐', '晚期'],
  ],
  夸夸模式: [
    [
      '你真棒',
      '好厉害',
      '太优秀',
      '继续冲',
      '爱了爱了',
      '就是你',
      '最强',
      '无敌',
      '牛啊',
      '收下膝盖',
    ],
    ['今天', '也很', '努力', '看见了', '辛苦了', '你超棒', '别怀疑', '就是行', '相信你', '冲吧'],
  ],
};

/** 画布配色库(主题 → 2 组端点色 a/b,插值生成 10 组渐变)。 */
const CANVAS_COLOR_THEMES: Record<
  string,
  {
    a: { fg: string; bgTop: string; bgBottom: string };
    b: { fg: string; bgTop: string; bgBottom: string };
  }
> = {
  暗夜: {
    a: { fg: '#00ff88', bgTop: '#0a0a0a', bgBottom: '#1a1a2e' },
    b: { fg: '#ff3366', bgTop: '#16213e', bgBottom: '#0f0c29' },
  },
  暖阳: {
    a: { fg: '#fff3e0', bgTop: '#ff9248', bgBottom: '#c54b1a' },
    b: { fg: '#4a2c2a', bgTop: '#ffd194', bgBottom: '#d1913c' },
  },
  极简白: {
    a: { fg: '#1a1a1a', bgTop: '#fafafa', bgBottom: '#e0e0e0' },
    b: { fg: '#37474f', bgTop: '#ffffff', bgBottom: '#cfd8dc' },
  },
  赛博朋克: {
    a: { fg: '#ff00ff', bgTop: '#2d0a4e', bgBottom: '#0a0a2e' },
    b: { fg: '#00ffff', bgTop: '#1a0a3e', bgBottom: '#0e0e2e' },
  },
  薄荷: {
    a: { fg: '#ffffff', bgTop: '#26a69a', bgBottom: '#00695c' },
    b: { fg: '#e8f5e9', bgTop: '#80cbc4', bgBottom: '#4db6ac' },
  },
  樱花: {
    a: { fg: '#ffffff', bgTop: '#ff8fab', bgBottom: '#d4678a' },
    b: { fg: '#8a1538', bgTop: '#ffd1dc', bgBottom: '#ffb3c6' },
  },
  海洋: {
    a: { fg: '#ffffff', bgTop: '#1976d2', bgBottom: '#0d47a1' },
    b: { fg: '#e1f5fe', bgTop: '#4fc3f7', bgBottom: '#0288d1' },
  },
  日落: {
    a: { fg: '#fff8e1', bgTop: '#ff6f61', bgBottom: '#c2185b' },
    b: { fg: '#fffde7', bgTop: '#ff9248', bgBottom: '#d84315' },
  },
  炸鸡红: {
    a: { fg: '#fff5f5', bgTop: '#e4002b', bgBottom: '#8c0018' },
    b: { fg: '#ffe8a3', bgTop: '#c2001f', bgBottom: '#4d000d' },
  },
  摆烂灰: {
    a: { fg: '#c9d1d9', bgTop: '#3a4048', bgBottom: '#1c1f24' },
    b: { fg: '#9aa4ae', bgTop: '#4a525c', bgBottom: '#262a30' },
  },
  多巴胺: {
    a: { fg: '#1a1a1a', bgTop: '#ffe45e', bgBottom: '#ff5c8a' },
    b: { fg: '#fffdf0', bgTop: '#5ce1e6', bgBottom: '#7b61ff' },
  },
  荧光绿: {
    a: { fg: '#0a1f0a', bgTop: '#b6ff3c', bgBottom: '#2fa60a' },
    b: { fg: '#eaffd0', bgTop: '#1f7a1f', bgBottom: '#05330a' },
  },
};

/**
 * 主题别名(用户/AI 输的词 → 库里的主题名)。
 * 只靠"互相包含"匹配不到 KFC→疯狂星期四、躺平→摆烂中 这类,会静默随机,像坏了。
 */
const TOPIC_ALIASES: Record<string, string[]> = {
  疯狂星期四: ['kfc', '肯德基', 'v我50', 'v50', '星期四文学', '炸鸡', '疯四'],
  摆烂中: ['摆烂', '躺平', '摸鱼', '划水', '不想干', '咸鱼'],
  发疯文学: ['发疯', '疯了', '崩溃', 'emo了', '要疯'],
  老板画饼: ['老板', '画饼', '领导', '资本家', '加班文化'],
  今天星期几: ['星期几', '周几', '工作日', '周一', '周五'],
  发工资了: ['工资', '发薪', '薪水', '月底', '暴富'],
  早八人: ['早八', '起床', '闹钟', '迟到', '上课'],
  晚安世界: ['晚安', '睡觉', '睡前', '洗澡'],
  恭喜发财: ['新年', '春节', '过年', '发财', '拜年', '红包'],
  社恐日常: ['社恐', '内向', '不想说话', '社交'],
  夸夸模式: ['夸夸', '夸我', '彩虹屁', '鼓励', '表扬'],
  猫猫语录: ['猫', '喵', '猫咪', '铲屎'],
  早安问候: ['早安', '早上好', '问候'],
  深夜emo: ['emo', '深夜', '熬夜', '失眠', '凌晨'],
  干饭人: ['干饭', '吃饭', '外卖', '美食', '饿'],
  打工人日常: ['打工', '上班', '搬砖', '职场', '牛马'],
};

/** 列出全部配色主题名。 */
export function listColorThemes(): string[] {
  return Object.keys(CANVAS_COLOR_THEMES);
}

/** 列出全部文案主题名(给 UI 做一键选择的 chip)。 */
export function listCanvasTopics(): string[] {
  return Object.keys(CANVAS_TEXT_LIBRARY);
}

/**
 * 生成 10 句画布文案。
 * 主题精确命中 → 用它;模糊命中(互相包含)→ 用它;都不中 → 随机换一个主题
 * (原来会死落到"打工人日常",输什么都出打工人,像坏了)。返回实际用的主题名。
 */
export function generateCanvasTextsImpl(topic: string): { lines: string[]; topic: string } {
  const keys = Object.keys(CANVAS_TEXT_LIBRARY);
  const pick = <T>(arr: T[]): T | undefined => arr[Math.floor(Math.random() * arr.length)];
  let key = '';
  if (topic && CANVAS_TEXT_LIBRARY[topic]) {
    key = topic;
  } else if (topic) {
    const q = topic.toLowerCase();
    // 先按别名命中(KFC → 疯狂星期四),再退回互相包含
    key =
      Object.keys(TOPIC_ALIASES).find((k) =>
        TOPIC_ALIASES[k]?.some((a) => q.includes(a) || a.includes(q)),
      ) ?? '';
    if (!key) key = keys.find((k) => topic.includes(k) || k.includes(topic)) ?? '';
  }
  if (!key) key = pick(keys) ?? '打工人日常';
  const pool = CANVAS_TEXT_LIBRARY[key] ?? [];
  const lines = [...(pick(pool) ?? [])];
  while (lines.length < 10) lines.push('');
  return { lines: lines.slice(0, 10), topic: key };
}

/** 生成 10 组画布配色(主题匹配 → 插值 + 随机扰动)。 */
export function generateCanvasColorsImpl(theme: string): {
  palettes: { fg: string; bgTop: string; bgBottom: string }[];
} {
  const keys = Object.keys(CANVAS_COLOR_THEMES);
  const fallback = CANVAS_COLOR_THEMES['暗夜'] ?? {
    a: { fg: '#ffffff', bgTop: '#0a0a0a', bgBottom: '#1a1a1a' },
    b: { fg: '#ffffff', bgTop: '#0a0a0a', bgBottom: '#1a1a1a' },
  };
  let t = fallback;
  if (theme && CANVAS_COLOR_THEMES[theme]) {
    t = CANVAS_COLOR_THEMES[theme] ?? fallback;
  } else if (theme) {
    for (const k of keys) {
      if (theme.includes(k) || k.includes(theme)) {
        t = CANVAS_COLOR_THEMES[k] ?? fallback;
        break;
      }
    }
  } else {
    const randKey = keys[Math.floor(Math.random() * keys.length)] ?? '暗夜';
    t = CANVAS_COLOR_THEMES[randKey] ?? fallback;
  }
  const lerpHex = (a: string, b: string, f: number) => {
    const pa = Number.parseInt(a.slice(1), 16),
      pb = Number.parseInt(b.slice(1), 16);
    const r = Math.round(((pa >> 16) & 0xff) * (1 - f) + ((pb >> 16) & 0xff) * f);
    const g = Math.round(((pa >> 8) & 0xff) * (1 - f) + ((pb >> 8) & 0xff) * f);
    const bl = Math.round((pa & 0xff) * (1 - f) + (pb & 0xff) * f);
    return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`;
  };
  const jitter = (hex: string) => {
    const p = Number.parseInt(hex.slice(1), 16);
    const r = Math.max(
      0,
      Math.min(255, ((p >> 16) & 0xff) + (Math.floor(Math.random() * 40) - 20)),
    );
    const g = Math.max(0, Math.min(255, ((p >> 8) & 0xff) + (Math.floor(Math.random() * 40) - 20)));
    const bl = Math.max(0, Math.min(255, (p & 0xff) + (Math.floor(Math.random() * 40) - 20)));
    return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`;
  };
  /** 相对亮度 0-1。 */
  const luma = (hex: string) => {
    const p = Number.parseInt(hex.slice(1), 16);
    return (0.299 * ((p >> 16) & 0xff) + 0.587 * ((p >> 8) & 0xff) + 0.114 * (p & 0xff)) / 255;
  };
  /**
   * 文字与背景的对比度保底。
   * fg 在"深↔浅"两端之间插值、bg 又独立插值时,中间必然撞出灰字压灰底(浅字压浅底)
   * —— 「多巴胺」这类主题曾经就有好几帧根本看不清。差得不够就把 fg 掰到黑或白那一端。
   */
  const ensureContrast = (fg: string, bgTop: string, bgBottom: string) => {
    const bg = (luma(bgTop) + luma(bgBottom)) / 2;
    if (Math.abs(luma(fg) - bg) >= 0.42) return fg;
    return bg > 0.5 ? '#14171a' : '#fffdf5';
  };
  const palettes = Array.from({ length: 10 }, () => {
    const f = Math.random();
    const bgTop = jitter(lerpHex(t.a.bgTop, t.b.bgTop, f));
    const bgBottom = jitter(lerpHex(t.a.bgBottom, t.b.bgBottom, f));
    return {
      fg: ensureContrast(jitter(lerpHex(t.a.fg, t.b.fg, f)), bgTop, bgBottom),
      bgTop,
      bgBottom,
    };
  });
  return { palettes };
}
