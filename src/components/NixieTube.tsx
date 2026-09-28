/**
 * 电子立牌模拟器（对齐实机形态）：6 块 135×240 竖屏并排插在底座上，
 * 实机把它们当 6 个「数码管」用 —— 每块屏显示一个大字符，拼成 HHMMSS 走时。
 * 图组即数字 0–9 的 10 帧皮肤；每秒读表换帧，所有访客同一时刻同一画面。
 *
 * 帧数 ≥ 10：按 HHMMSS 各位取 frames[digit]（真数字钟）；
 * 帧数 < 10：无数字语义，退化为 6 管同显 frames[seconds % frames.length]（皮肤轮播）。
 *
 * 外观按官方产品照 + 实拍（IMG_0289/1084/1085/1086）标定：
 * - 胶囊玻璃罩（直筒+顶半球）：罩可见高/罩径 ≈ 2.05、顶球占 0.5/2.05 ≈ 24%；
 *   顶弧圆润（官方照 smooth rounded top）；顶灯折角条状高光、左右壁竖直反光；
 *   屏光把整罩从内照亮（实拍罩体泛屏色），底部溢光最亮。
 * - 直角黑边屏：屏体外宽 ≈ 罩宽 72%、屏顶距罩顶 0.55；屏底直通到底座顶面。
 *   画面占屏体上部（宽 0.667，135:240），画面以下留一段黑色支架颈到台面。
 * - 底座（实拍 IMG_1084/1085/1086）：顶面是平面、哑光黑，罩脚/屏底同落一个水平面；
 *   顶面到立面有一圈斜面（bevel）过渡，再往下是竖直、纯黑、略内收的立面；
 *   两端是小菱形切面收头（45°，小）；正面中央金色 NIXIES logo。
 * - 管心距 ≈ 1.70 罩径（gap ≈ 0.70，官方照紧凑排布）。
 * - 底座为单层黑色哑光阳极氧化铝长方体：全高 ≈ 0.78 罩径（顶面:立面 ≈ 1:2.6），
 *   两端上窄下宽斜切收头（剪影 + 两端受光渐变 + 顶/立面棱线表达体积）；
 *   正面中央金色 NIXIES logo + 「LOCAL DISPLAY TOOL」小字标语；
 *   底面两端露半圆橡胶脚垫。
 * - 背面（IMG_0920 实机即此面）：每根罩内一块竖立黑色 PCB，金色走线/导通孔从中心
 *   向四周发散，正中沉金花体字母，六管连读 NIXIES（一管一字母）；底座背面干净哑光黑，
 *   仅立面偏右 Type-C 口 + 圆形微动键。点击展台「翻到背面」切换。
 */
import { useEffect, useState } from 'react'
import { frameUrl } from '../lib/frame'
import { useSharedClock } from '../lib/clock'

export interface NixieTubeProps {
  /** 皮肤帧（135×240 JPEG base64，无 data: 前缀）；数字钟皮肤应为 0–9 共 10 帧 */
  frames: string[]
  /** 外框主题 */
  theme?: 'light' | 'dark'
  /** 每管之间的最大并排数量（默认 6 = HHMMSS） */
  tubes?: number
  /** 空帧占位文案 */
  placeholder?: string
  /** 传入则受控（外部驱动正/背面），不传组件自带切换钮 */
  face?: 'front' | 'back'
  onFaceChange?: (f: 'front' | 'back') => void
  /** 不订阅共享时钟（编辑态预览给 true）：
   *  不每 250ms 重渲染，帧内容变化时（改配置/换预览）才更新。 */
  noClock?: boolean
}

/** 背面每块 PCB 上的花体字母，从左到右连读 NIXIES —— 罩子里装的本来就是拟辉光管（Nixie tube），
 *  6 根管对 6 个字母，一管一字母（IMG_0920 实机背面）；
 *  tubes 少于 6 时按位取前缀，多于字母数时按 i % length 循环取用。 */
const BACK_LETTERS = ['N', 'I', 'X', 'I', 'E', 'S'] as const

/** ── 外观标定常量（2026-09-09 官方产品照 + 实拍互证标定，单位 = 罩径 D）────
 *  罩宽 1、罩可见高 2.05（顶球 0.5 + 直筒 1.55）—— 官方照罩子高挑（≈2:1），
 *  顶弧圆润占罩高 24%；管心距 1.70（管间隙 0.70 罩径，收藏套装式紧凑排布）；
 *  屏幕顶部留一段黑颈（屏顶距罩顶 0.55）；屏体外宽 0.72、画面宽 0.667（135:240）
 *  贴屏体上部、左右窄黑边，屏底直通台面；
 *  底座扁平：全高 0.34（一条矮台子），两端平直、logo 居中。
 *  2D 布局坐标系：容器宽 = 底座长 → 1D = 100/BASE_LEN cqw。 */
const PITCH = 1.7
const TUBE_VISIBLE_H = 2.05
/** 底座长 = 罩群跨度（5×管心距 + 罩径）+ 两端各 0.55 台面 */
const BASE_LEN = 5 * PITCH + 1 + 2 * 0.55
/** 底座全高（微俯视实拍：扁平一条，有倒角但不笨重） */
const BASE_H = 0.34
/** 罩脚下藏进底座顶面板的深度（罩脚被顶面盖住一小段，形成落座衔接） */
const TUBE_INSERT = 0.05
/** 屏体外宽（罩径 0.72）；屏顶距罩顶 0.55；画面宽 0.667 */
const SCREEN_W = 0.72
const SCREEN_TOP = 0.55
const FRAME_W = 0.667
/** 罩总高（可见 + 插入段）：屏体 top/bottom 百分比的分母 */
const TUBE_TOTAL_H = TUBE_VISIBLE_H + TUBE_INSERT

/** 当前时刻 6 管应显示的帧下标 */
export function tubeIndexes(frameCount: number, now = new Date()): number[] {
  if (frameCount <= 0) return []
  if (frameCount >= 10) {
    // HHMMSS：时 2 管 + 分 2 管 + 秒 2 管
    const digits = [
      Math.floor(now.getHours() / 10) % 10,
      now.getHours() % 10,
      Math.floor(now.getMinutes() / 10) % 10,
      now.getMinutes() % 10,
      Math.floor(now.getSeconds() / 10) % 10,
      now.getSeconds() % 10,
    ]
    return digits.map((d) => d % frameCount)
  }
  // 帧数不足 10（电子立牌 6 帧等）：无数字语义 —— 6 管各显一帧（胶片条铺满整套图）。
  // 静态、不随秒翻：轮播归设备端管，预览只展示这套图本身；
  // 下标与时间无关 → NixieTube 也不订阅共享时钟（不每秒重渲染）。
  return Array.from({ length: 6 }, (_, i) => i % frameCount)
}

/**
 * 屏幕帧主色（溢光 / 氛围灯 / 背面反射用）：
 * 1×1 canvas 缩放采样取主色，整体过暗时提亮，供跨组件共享的色相引用。
 */
export function useFrameTint(frame: string | undefined): string {
  const [tint, setTint] = useState<string | null>(null)
  useEffect(() => {
    if (!frame) {
      setTint(null)
      return
    }
    let alive = true
    const img = new Image()
    img.onload = () => {
      try {
        const c = document.createElement('canvas')
        c.width = 1
        c.height = 1
        const ctx = c.getContext('2d')
        if (!ctx) return
        ctx.drawImage(img, 0, 0, 1, 1)
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
        // 太暗的帧提亮，保证罩内可见一层屏光色
        const mx = Math.max(r, g, b)
        const k = mx > 0 && mx < 120 ? Math.min(2.2, 120 / mx) : 1
        const rr = Math.round(Math.min(255, r * k))
        const gg = Math.round(Math.min(255, g * k))
        const bb = Math.round(Math.min(255, b * k))
        if (alive) setTint(`${rr},${gg},${bb}`)
      } catch {
        /* 跨域帧等取不到像素：忽略溢光 */
      }
    }
    img.src = frameUrl(frame)
    return () => {
      alive = false
    }
  }, [frame])
  return tint ?? '120,140,180'
}

/** 单个罩体内容（正面：屏皮肤 + 溢光；背面：金色电路 PCB + 花体字母），随外层罩形裁切 */
function TubeFace({
  frame,
  eager,
  alt,
  face,
  letter,
}: {
  frame: string
  eager: boolean
  alt: string
  face: 'front' | 'back'
  letter: string
}) {
  if (face === 'back') {
    // 背面（IMG_0920 实测）：每根罩内是一块竖立的黑色 PCB，哑黑阻焊底 + 金色
    // 走线/导通孔/焊盘从中心向四周发散铺满版面，正中一块沉金的花体字母（一管一字母，6 管合读 NIXIES）。
    // PCB 与正面屏体同位：宽 0.72 罩径，顶距罩顶 0.55，向下直通底座顶面。
    // 用 cqw 绝对尺寸（组件根是 container query 根），不依赖罩体百分比高度。
    const CQW = 100 / BASE_LEN
    return (
      <div
        className="absolute left-1/2 -translate-x-1/2"
        style={{
          top: `${SCREEN_TOP * CQW}cqw`,
          height: `${(TUBE_TOTAL_H - SCREEN_TOP) * CQW}cqw`,
          width: `${SCREEN_W * CQW}cqw`,
          containerType: 'inline-size',
          background: 'linear-gradient(160deg, #141517 0%, #0c0d0e 55%, #08090a 100%)',
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.06), inset 0 0 10px rgba(0,0,0,0.85)',
        }}
      >
        {/* 金色电路走线：从中心字符区向四周发散 + 导通孔焊盘（沉金 #c9a24a） */}
        <svg
          viewBox="0 0 76 135"
          className="absolute inset-0 h-full w-full"
          preserveAspectRatio="none"
          aria-hidden
        >
          <g stroke="#7a5e22" strokeWidth="0.9" opacity="0.55" fill="none" strokeLinejoin="round">
            {/* 主干：中心向四角与四边发散的折线走线 */}
            <path d="M38 68 V20 H12 V6" />
            <path d="M38 68 V118 H62 V132" />
            <path d="M38 68 H8 V42" />
            <path d="M38 68 H70 V92" />
            <path d="M38 68 L14 20" />
            <path d="M38 68 L64 118" />
            <path d="M20 68 H4" />
            <path d="M56 68 H74" />
            <path d="M38 68 V130" />
            <path d="M38 40 H60 V24" />
            <path d="M38 96 H16 V110" />
          </g>
          <g stroke="#b8912f" strokeWidth="1.1" opacity="0.7" fill="none" strokeLinejoin="round">
            <path d="M28 56 h6 v-6 h6" />
            <path d="M48 80 h-6 v6 h-6" />
            <path d="M18 40 v10" />
            <path d="M58 96 v-10" />
          </g>
          {/* 导通孔（过孔圆环） */}
          <g fill="none" stroke="#c9a24a" strokeWidth="0.9" opacity="0.7">
            <circle cx="12" cy="6" r="2.2" />
            <circle cx="62" cy="132" r="2.2" />
            <circle cx="8" cy="42" r="1.9" />
            <circle cx="70" cy="92" r="1.9" />
            <circle cx="14" cy="20" r="1.6" />
            <circle cx="64" cy="118" r="1.6" />
            <circle cx="4" cy="68" r="1.5" />
            <circle cx="74" cy="68" r="1.5" />
          </g>
          {/* 焊盘亮点 */}
          <g fill="#d8b25a" opacity="0.85">
            <circle cx="38" cy="20" r="1.2" />
            <circle cx="38" cy="118" r="1.2" />
            <circle cx="18" cy="68" r="1" />
            <circle cx="58" cy="68" r="1" />
            <circle cx="60" cy="24" r="1.3" />
            <circle cx="16" cy="110" r="1.3" />
          </g>
        </svg>
        {/* 中心字母（沉金，一管一字母；6 管连读 NIXIES）：实机标是圆润粗黑体（非西文花体）。
            字号随 PCB 宽缩放占高约五成，字重 900、微字距 */}
        <span
          aria-hidden
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
          style={{
            fontFamily:
              '"Arial Rounded MT Bold", "Varela Round", ui-rounded, "SF Pro Rounded", system-ui, sans-serif',
            fontSize: 'clamp(20px, 62cqw, 64px)',
            fontWeight: 900,
            lineHeight: 1,
            letterSpacing: '0.02em',
            color: '#e8c76e',
            textShadow: '0 0 5px rgba(232,199,110,0.5), 0 1.5px 0 rgba(0,0,0,0.9)',
          }}
        >
          {letter}
        </span>
      </div>
    )
  }
  // 屏体用 cqw 绝对尺寸（组件根是 container query 根，1D = 100/BASE_LEN cqw），
  // 不依赖罩体百分比高度（cqw 高度未决时 top/bottom% 会塌成 0 → 屏不显示）。
  const CQW = 100 / BASE_LEN
  return (
    <div
      className="absolute left-1/2 -translate-x-1/2 overflow-hidden bg-[#050505]"
      style={{
        // 实拍 IMG_1084/1085：屏插在罩内，屏体外宽 0.72 罩径，顶距罩顶 0.55；
        // 屏底直通到底座顶面。画面占屏体上部（宽 92.6%），画面顶距屏顶 ≈1%；
        // 画面以下留一段黑色支架颈到台面。
        top: `${SCREEN_TOP * CQW}cqw`,
        height: `${(TUBE_TOTAL_H - SCREEN_TOP) * CQW}cqw`,
        width: `${SCREEN_W * CQW}cqw`,
      }}
    >
      <img
        src={frameUrl(frame)}
        alt={alt}
        className="absolute left-1/2 top-[1%] -translate-x-1/2 object-cover"
        style={{ width: `${(FRAME_W / SCREEN_W) * 100}%`, aspectRatio: '135 / 240' }}
        draggable={false}
        loading={eager ? 'eager' : 'lazy'}
      />
      {/* 屏幕玻璃微反光（斜向一道） */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'linear-gradient(105deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0) 28%)',
        }}
      />
    </div>
  )
}

/** 单管：玻璃罩（直筒下端插进底座顶面，无垫圈盘）→ 底座顶面。
 *  罩形按实拍 + 实物扫描互证标定：罩可见高/罩径 ≈ 2.05，顶球占 0.5/2.05 ≈ 24%。
 *  pos：管位偏移（-2.5..2.5），顶灯反光位置/强度随位置微变，消整排复制感 */
function Tube({
  frame,
  eager,
  alt,
  face,
  tint,
  pos = 0,
  letter,
}: {
  frame: string
  eager: boolean
  alt: string
  face: 'front' | 'back'
  tint: string
  pos?: number
  letter: string
}) {
  return (
    <div className="relative flex min-w-0 flex-col items-center" style={{ width: '100%' }}>
      {/*
        玻璃罩（官方产品照 + 实拍互证标定）：
        - 可见高宽比 H/W ≈ 2.05；顶部半球占罩高 ≈ 24%（0.5/2.05），顶弧圆润
        - 底部平切，直筒侧壁竖直插进底座顶面（实拍：透过玻璃可见背景直到台面）
        - 屏光把整罩从内照亮（实拍 IMG_1084：罩体泛屏色，越近屏越亮）
      */}
      <div
        className="relative z-10 w-full"
        style={{
          // 罩可见高 + 插入段（下端 TUBE_INSERT 藏进底座顶面，负 margin 上拉吃掉）
          height: `${TUBE_TOTAL_H * (100 / BASE_LEN)}cqw`,
          borderRadius: '50% 50% 0 0 / 24% 24% 0 0',
          // 圆柱玻璃：横向「边缘亮→近边压暗→中心受光→再压暗→边缘亮」的柱面明暗，
          // 叠极淡整体反光。中心那抹受光是筒面正对镜头的成像，两侧暗环给出圆弧度。
          background: [
            'linear-gradient(90deg, rgba(255,255,255,0.16) 0%, rgba(0,0,0,0.28) 12%, rgba(255,255,255,0.05) 30%, rgba(255,255,255,0.10) 50%, rgba(255,255,255,0.03) 70%, rgba(0,0,0,0.26) 88%, rgba(255,255,255,0.13) 100%)',
            'linear-gradient(180deg, rgba(255,255,255,0.04), transparent 30%)',
            `linear-gradient(0deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.25) ${(TUBE_INSERT / TUBE_TOTAL_H) * 100}%, transparent ${((TUBE_INSERT + 0.25) / TUBE_TOTAL_H) * 100}%)`,
          ].join(', '),
          boxShadow: [
            'inset 0 0 0 1px rgba(255,255,255,0.08)',
            'inset 0 -6px 8px -8px rgba(150,170,200,0.25)',
          ].join(', '),
        }}
      >
        <TubeFace frame={frame} eager={eager} alt={alt} face={face} letter={letter} />

        {/* 罩内透光：屏光把整罩从内照亮（实拍 IMG_1084 罩体泛屏色）——
            正面亮一档（直视屏光），背面透过 PCB 只剩弱光 */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background: `radial-gradient(120% 65% at 50% 78%, rgba(${tint},${face === 'front' ? 0.14 : 0.05}) 0%, rgba(${tint},${face === 'front' ? 0.05 : 0.02}) 45%, transparent 75%)`,
            mixBlendMode: 'screen',
          }}
        />

        {/* 落座阴影：罩底与底座顶面接触处的投影（接触暗线 + 上方渐弱） */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-[2%] bottom-0"
          style={{
            height: '7%',
            background:
              'linear-gradient(0deg, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.18) 45%, transparent 100%)',
          }}
        />

        {/* 屏光溢出照亮罩底内壁（正面更明显，背面透过玻璃只见弱光） */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-[10%] bottom-[2%] h-[24%]"
          style={{
            background: `linear-gradient(to top, rgba(${tint},${face === 'front' ? 0.16 : 0.05}), transparent 80%)`,
            borderRadius: '0 0 12% 12%',
          }}
        />

        {face === 'front' && (
          <>
            {/* 顶灯高光：实机是「竖线到半球顶折角弯成弧」的条状反光，非圆点。
                灯在头顶偏后：位置靠中间的管反光更居中更亮，边上的偏移更大更弱 */}
            <span
              aria-hidden
              className="pointer-events-none absolute top-[2%] h-[26%] w-[9%] rounded-full"
              style={{
                left: `${29 + pos * 4.6}%`,
                opacity: 0.8 - Math.abs(pos) * 0.14,
                transform: `rotate(${-24 - pos * 7}deg)`,
                background:
                  'linear-gradient(to bottom, rgba(255,255,255,0.2) 0%, rgba(255,255,255,0.78) 30%, rgba(255,255,255,0.68) 78%, rgba(255,255,255,0.1) 100%)',
                filter: 'blur(0.6px)',
              }}
            />
            <span
              aria-hidden
              className="pointer-events-none absolute top-[7%] h-[11%] w-[16%] rounded-[50%]"
              style={{
                left: `${33 + pos * 5}%`,
                opacity: 0.85 - Math.abs(pos) * 0.15,
                transform: `rotate(${-30 - pos * 8}deg)`,
                background:
                  'linear-gradient(120deg, rgba(255,255,255,0) 20%, rgba(255,255,255,0.45) 55%, rgba(255,255,255,0) 85%)',
                filter: 'blur(1.5px)',
              }}
            />
            {/* 罩左壁竖直反光长条（沿直筒段：左端最强，向右侧衰减） */}
            <span
              aria-hidden
              className="pointer-events-none absolute bottom-[10%] left-[6.5%] top-[30%] w-[4%] rounded-full"
              style={{
                opacity: 1 - Math.max(0, pos) * 0.3,
                background:
                  'linear-gradient(to bottom, rgba(255,255,255,0) 0%, rgba(255,255,255,0.30) 30%, rgba(255,255,255,0.30) 70%, rgba(255,255,255,0) 100%)',
                filter: 'blur(1.5px)',
              }}
            />
            {/* 罩右壁弱反光（远端受光略补一点） */}
            <span
              aria-hidden
              className="pointer-events-none absolute bottom-[12%] right-[6.5%] top-[32%] w-[3.5%] rounded-full"
              style={{
                opacity: 0.8 - Math.min(0, pos) * 0.3,
                background:
                  'linear-gradient(to bottom, rgba(255,255,255,0) 0%, rgba(255,255,255,0.13) 40%, rgba(255,255,255,0.13) 70%, rgba(255,255,255,0) 100%)',
                filter: 'blur(1.5px)',
              }}
            />
          </>
        )}

        {face === 'back' && (
          <>
            {/* 背面罩：反光对称、弱一档（无直射顶灯，只有环境漫反射） */}
            <span
              aria-hidden
              className="pointer-events-none absolute bottom-[12%] left-[7%] top-[30%] w-[3.5%] rounded-full"
              style={{
                background:
                  'linear-gradient(to bottom, rgba(255,255,255,0) 0%, rgba(255,255,255,0.16) 35%, rgba(255,255,255,0.16) 70%, rgba(255,255,255,0) 100%)',
                filter: 'blur(1.5px)',
              }}
            />
            <span
              aria-hidden
              className="pointer-events-none absolute bottom-[12%] right-[7%] top-[30%] w-[3.5%] rounded-full"
              style={{
                background:
                  'linear-gradient(to bottom, rgba(255,255,255,0) 0%, rgba(255,255,255,0.14) 35%, rgba(255,255,255,0.14) 70%, rgba(255,255,255,0) 100%)',
                filter: 'blur(1.5px)',
              }}
            />
            <span
              aria-hidden
              className="pointer-events-none absolute left-1/2 top-[3%] h-[6%] w-[24%] -translate-x-1/2 rounded-full"
              style={{
                background:
                  'radial-gradient(closest-side, rgba(255,255,255,0.22), rgba(255,255,255,0))',
                filter: 'blur(1px)',
              }}
            />
          </>
        )}
      </div>
    </div>
  )
}

/**
 * 底座（正/背面共用）：扁平细长的黑色长方体台子，结构按抠图轮廓。
 * 顶面是平面（抛光黑，能映出屏幕微光），立面竖直、哑光纯黑，两端平直；
 * 顶缘一条细倒角棱线，正面中央金色 NIXIES logo。管子直接立在顶面上、连成一体。
 * 没有分层斜面、没有多余横杠、没有垫圈/底座圈/脚垫。
 */
function Base({ face, tint }: { face: 'front' | 'back'; tint: string }) {
  // 全尺寸从标定常量推导（1D = 100/BASE_LEN cqw）。
  const cqw = (v: number) => `${v * (100 / BASE_LEN)}cqw`
  // 顶面（抛光黑）厚度：含管子下段沉入的一小段
  const TOP_H = TUBE_INSERT + 0.05
  return (
    // 台子本体：罩群以负 marginBottom 把管子下段压进顶面，连成一体
    <div className="relative" style={{ marginTop: `-${TUBE_INSERT * (100 / BASE_LEN)}cqw` }}>
      {/* 顶面（z-10 盖住罩脚那一小段）：抛光黑平面，能映出屏幕微光、有反光。
          与立面以一条细棱线分界。 */}
      <div
        className="relative z-10 w-full overflow-hidden"
        style={{
          height: cqw(TOP_H),
          background:
            'linear-gradient(180deg, #36363d 0%, #232327 40%, #17171a 100%)',
        }}
      >
        {/* 顶面反光：一道斜向环境光带 + 屏幕微光回映（正面才有彩光） */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'linear-gradient(115deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0) 34%)',
          }}
        />
        {face === 'front' && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-[8%] top-0"
            style={{ height: '60%', background: `linear-gradient(180deg, rgba(${tint},0.14), transparent)`, filter: 'blur(2px)' }}
          />
        )}
      </div>
      {/* 顶面/立面交界棱线：体现倒角的一条细横线 */}
      <div
        aria-hidden
        className="pointer-events-none absolute z-20"
        style={{
          left: '0.8%',
          right: '0.8%',
          top: `calc(${cqw(TOP_H)} - 1px)`,
          height: '1px',
          background: 'linear-gradient(90deg, rgba(255,255,255,0.34), rgba(255,255,255,0.16) 50%, rgba(255,255,255,0.28))',
        }}
      />
      {/* 立面（z-0 在罩群之下）：竖直哑光纯黑，两端平直。logo 居中。 */}
      <div className="relative z-0 w-full" style={{ height: cqw(BASE_H - TOP_H) }}>
        <div
          className="absolute inset-0"
          style={{
            // 竖直立面近纯黑：两端微受光，底部落影
            background: [
              'linear-gradient(180deg, rgba(255,255,255,0.05) 0%, transparent 18%, rgba(0,0,0,0.5) 82%, rgba(0,0,0,0.7) 100%)',
              'linear-gradient(90deg, #232327 0%, #141416 12%, #101012 50%, #141416 88%, #222226 100%)',
            ].join(', '),
          }}
        />
        {/* 底缘落影 */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent"
          style={{ height: '0.4cqw' }}
        />
        {/* 喷砂微颗粒：极淡噪点 */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.05]"
          style={{
            background:
              'radial-gradient(rgba(255,255,255,0.8) 0.5px, transparent 0.6px) 0 0 / 5px 5px, radial-gradient(rgba(255,255,255,0.5) 0.4px, transparent 0.5px) 2px 3px / 7px 6px',
          }}
        />
        {/* 正面：金色 NIXIES logo 居中 */}
        {face === 'front' && (
          <span
            aria-hidden
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center leading-none"
            style={{
              fontFamily:
                '"Arial Rounded MT Bold", "Varela Round", ui-rounded, "SF Pro Rounded", system-ui, sans-serif',
              color: '#d9b96c',
              textShadow: '0 0 3px rgba(217,185,108,0.35), 0 0.5px 0 rgba(0,0,0,0.8)',
            }}
          >
            <span
              className="block"
              style={{ fontSize: '1.3cqw', fontWeight: 800, letterSpacing: '0.03em' }}
            >
              NIXIES
            </span>
            <span
              className="mt-[0.18cqw] block"
              style={{ fontSize: '0.38cqw', fontWeight: 600, letterSpacing: '0.22em', opacity: 0.72 }}
            >
              LOCAL DISPLAY TOOL
            </span>
          </span>
        )}
        {/* 背面：哑光黑干净，仅中央偏右 Type-C 口 + 右侧圆形微动键 */}
        {face === 'back' && (
          <>
            <span
              aria-hidden
              className="absolute rounded-full bg-[#030304]"
              style={{
                right: '32%',
                top: '46%',
                width: '1.7cqw',
                height: '0.62cqw',
                boxShadow: 'inset 0 0 0 0.5px rgba(255,255,255,0.26)',
              }}
            >
              <span
                className="absolute left-[26%] right-[26%] top-1/2 -translate-y-1/2 rounded-full bg-zinc-600/70"
                style={{ height: '1px' }}
              />
            </span>
            <span
              aria-hidden
              className="absolute rounded-full bg-[#18181b]"
              style={{
                right: '24%',
                top: '43%',
                width: '1.15cqw',
                height: '1.15cqw',
                boxShadow:
                  'inset 0 1px 1px rgba(0,0,0,0.9), inset 0 -0.5px 0 rgba(255,255,255,0.08), 0 0 0 0.6px rgba(255,255,255,0.16)',
              }}
            />
          </>
        )}
      </div>
    </div>
  )
}

export default function NixieTube({
  frames,
  tubes = 6,
  placeholder,
  face,
  onFaceChange,
  noClock,
}: NixieTubeProps) {
  const [innerFace, setInnerFace] = useState<'front' | 'back'>('front')
  const faceNow = face ?? innerFace
  const setFace = (f: 'front' | 'back') => {
    if (onFaceChange) onFaceChange(f)
    else setInnerFace(f)
  }

  // 共享时钟 250ms 读表：帧号按秒派生，换帧滞后 ≤ 250ms；后台节流切回自愈。
  // 全站单 interval（此前每行各起定时器，12 行 = 48 次/秒 setState）。
  // noClock（编辑态预览）：不订阅共享时钟 —— 帧内容变化时才重渲染，
  // 不跟着页面上的活钟每 250ms 走表（省一整页 setState/秒）。
  // 帧数 <10（电子立牌 6 帧等）：tubeIndexes 与时间无关 —— 同样不订阅，
  // 整个组件静态渲染（6 管各显一帧，不随秒翻页/不每秒 setState）。
  const clocked = !noClock && frames.length >= 10
  const now = useSharedClock(clocked)

  // 首管帧主色（整组色调一致，近似用于底座回光）
  const tint = useFrameTint(frames[0])

  if (frames.length === 0) {
    return (
      <div className="flex w-full items-center justify-center py-10 text-xs text-zinc-400">
        {placeholder ?? '无预览帧'}
      </div>
    )
  }

  const idxs = tubeIndexes(frames.length, now)
  const useTubes = Math.min(tubes, 6)

  // ── 标定常量（实物扫描 + 实拍互证，单位 = 罩径 D；见组件头注释）──
  // 容器宽 = 底座长 10.35D → 1D = 100/10.35 = 9.66cqw
  const CQW = 100 / BASE_LEN
  const GAP_RATIO = PITCH - 1 // 罩间隙 = 管心距 - 罩径 = 0.80D
  const TUBE_W = 1 // 罩径
  return (
    <div className="flex w-full select-none flex-col items-center">
      {/* container query 根：罩宽 ≈ 6.5cqw，底座/端口等固定像素件一律按 cqw 等比缩放，
          避免罩放大后底座还是原来那点高度 → 「管子顶在细板上飞起来」的失衡感 */}
      <div className="relative w-full" style={{ containerType: 'inline-size' }}>
        {/* —— 罩群 + 垫圈区 ——
            背面字母按正视从左到右读作 NIXIES，故不镜像整排（正反面各自独立渲染内容）。 */}
        {/* —— 罩群：脚与底座顶面零缝（底座 marginTop 上拉吃掉插入段）——
            背面字母按正视从左到右读作 NIXIES，故不镜像整排。 */}
        <div
          className="relative z-10 flex items-end justify-center"
          style={{ gap: `${GAP_RATIO * CQW}cqw`, marginBottom: `-${TUBE_INSERT * CQW}cqw` }}
        >
          {idxs.slice(0, useTubes).map((idx, i) => (
            <div key={i} className="min-w-0" style={{ width: `${TUBE_W * CQW}cqw` }}>
              <Tube
                frame={frames[idx % frames.length]}
                eager={i === 0}
                alt={i === 0 ? `第 ${idx + 1} 帧` : ''}
                face={faceNow}
                tint={tint}
                pos={i - (useTubes - 1) / 2}
                letter={BACK_LETTERS[i % BACK_LETTERS.length]}
              />
            </div>
          ))}
        </div>

        {/* —— 底座 —— */}
        <Base face={faceNow} tint={tint} />

        {/* 桌面接触阴影：近实远虚（在容器内才能吃 cqw；随展台等比） */}
        <div
          aria-hidden
          className="mx-auto mt-[3px] w-[86%] rounded-[50%]"
          style={{
            height: '1.3cqw',
            background:
              'radial-gradient(closest-side, rgba(0,0,0,0.65) 20%, rgba(0,0,0,0.25) 60%, rgba(0,0,0,0))',
            filter: 'blur(3px)',
          }}
        />

        {/* 正/背面切换钮（固定右下角，落在底座下方展台区，不碰管子/画面，翻面不移动）。
            受控 face（外部传 face）时不渲染 —— 外部已把翻面钮放在展台底部，
            内部再出一颗会嵌进外部按钮里（非法嵌套 button）。 */}
        {onFaceChange === undefined && !face ? (
          <button
            type="button"
            onClick={() => setFace(faceNow === 'front' ? 'back' : 'front')}
            className="absolute right-[2px] z-10 rounded-full border border-white/15 bg-black/50 px-2 py-[3px] text-[9px] leading-none text-zinc-300 backdrop-blur-sm transition-colors hover:bg-black/70 hover:text-white"
            style={{ bottom: '-26px' }}
            title={faceNow === 'front' ? '查看背面（Type-C 与按键）' : '返回正面'}
          >
            {faceNow === 'front' ? '翻到背面 →' : '← 翻回正面'}
          </button>
        ) : null}
      </div>
    </div>
  )
}
