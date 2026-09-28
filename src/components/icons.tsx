/**
 * 站点内统一使用的 MingCute 图标（https://www.mingcute.com/）
 * 全部是 inline SVG，随包携带，无外部请求
 */
import type { ReactElement, SVGProps } from 'react'

type P = SVGProps<SVGSVGElement>

function base(props: P): P {
  return {
    width: '1em',
    height: '1em',
    viewBox: '0 0 24 24',
    'aria-hidden': true,
    ...props,
  }
}

/** 下载（⬇） */
export function IconDownload(props: P): ReactElement {
  return (
    <svg {...base(props)}>
      <path
        fill="currentColor"
        d="M13 3a1 1 0 1 0-2 0zm-2 13a1 1 0 1 0 2 0zm-1.828-4a1 1 0 1 0-1.415 1.414l.707-.707zM12 16.243l-.707.707a1 1 0 0 0 1.414 0zm4.243-2.829A1 1 0 1 0 14.828 12l.708.707zM20 7h-1v13h2V7zm-1 14v-1H5v2h14zM4 20h1V7H3v13zM5 6v1h3V5H5zm11 0v1h3V5h-3zm-4-3h-1v13h2V3zm-3.536 9.707l-.707.707l3.536 3.536l.707-.707l.707-.707L9.172 12zM12 16.243l.707.707l3.536-3.536l-.707-.707l-.708-.707l-3.535 3.536zM4 7h1V5a2 2 0 0 0-2 2zm1 14v-1H3a2 2 0 0 0 2 2zm15-1h-1v2a2 2 0 0 0 2-2zm0-13h1a2 2 0 0 0-2-2v2z"
      />
    </svg>
  )
}

/** 点赞-已赞（❤️ 实心） */
export function IconHeartFill(props: P): ReactElement {
  return (
    <svg {...base(props)}>
      <path
        fill="currentColor"
        d="M18.494 3.801c2.095 1.22 3.569 3.7 3.504 6.592C21.86 16.5 13.5 21 12 21s-9.861-4.5-9.998-10.607C1.937 7.5 3.411 5.022 5.506 3.8c1.96-1.142 4.422-1.148 6.494.537c2.072-1.685 4.534-1.679 6.494-.537"
      />
    </svg>
  )
}

/** 点赞-未赞（🤍 描边） */
export function IconHeartLine(props: P): ReactElement {
  return (
    <svg {...base(props)}>
      <path
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
        d="M12 5.705c-3.692-3.947-9.114-.478-8.998 4.666q.102 4.59 7.19 8.8c.274.163.706.41 1.08.62a1.48 1.48 0 0 0 1.457 0c.373-.21.805-.457 1.08-.62q7.085-4.21 7.19-8.8c.115-5.144-5.307-8.613-8.999-4.666Z"
      />
    </svg>
  )
}

/** 收藏-已收藏（★ 实心；本地库的收藏星标，替代点赞语义） */
export function IconStarFill(props: P): ReactElement {
  return (
    <svg {...base(props)}>
      <path
        fill="currentColor"
        d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.4l-5.8 3 1.1-6.4-4.7-4.6 6.5-.9z"
      />
    </svg>
  )
}

/** 收藏-未收藏（☆ 描边） */
export function IconStarLine(props: P): ReactElement {
  return (
    <svg {...base(props)}>
      <path
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
        d="M12 3.5l2.7 5.4 6 .9-4.3 4.2 1 6-5.4-2.8-5.4 2.8 1-6L3.3 9.8l6-.9z"
      />
    </svg>
  )
}

/** 评论（💬） */
export function IconComment(props: P): ReactElement {
  return (
    <svg {...base(props)}>
      <path
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
        d="M18 7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h.5a.5.5 0 0 1 .5.5v2a.25.25 0 0 0 .4.2l.1-.075M14.638 18H11a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-.5a.5.5 0 0 0-.5.5v1.466a.25.25 0 0 1-.41.192l-2.312-1.926a1 1 0 0 0-.64-.232"
      />
    </svg>
  )
}

/** 日志（协议帧列表：三条错落横线） */
export function IconLog(props: P): ReactElement {
  return (
    <svg {...base(props)}>
      <path
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
        d="M4 6h12M4 12h16M4 18h9"
      />
    </svg>
  )
}

/** 删除（🗑） */
export function IconDelete(props: P): ReactElement {
  return (
    <svg {...base(props)}>
      <path
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
        d="m5 6l.876 13.133A2 2 0 0 0 7.87 21h8.258a2 2 0 0 0 1.995-1.867L19 6M8 6l.772-2.316A1 1 0 0 1 9.721 3h4.558a1 1 0 0 1 .949.684L16 6m-6 5v5m4-5v5M4 6h16"
      />
    </svg>
  )
}

/** 人气（🔥 实心火焰） */
export function IconFire(props: P): ReactElement {
  return (
    <svg {...base(props)}>
      <path
        fill="currentColor"
        d="M10.014 2.836C9.797 4.135 9.16 5.379 8.41 6.438a13.5 13.5 0 0 1-2.065 2.306C2.97 11.67 2.23 14.85 3.276 17.476c1 2.511 3.538 4.232 6.114 4.518l.805.089c-.814-.473-1.644-1.31-2.039-2.31c-.33-.838-.411-1.572-.26-2.292c.326-1.545 1.438-2.994 3.574-4.329l1.077-.673l.402 1.205c.213.637.473 1.082.744 1.468c.298.425.636.82.909 1.261c.318.518.564 1.115.643 1.918c.043.429-.052.904-.245 1.442c-.379 1.05-1.005 1.873-1.866 2.33l.976-.109c2.418-.268 4.193-1.096 5.346-2.48C20.6 18.145 21 16.38 21 14.5c0-1.75-.72-3.554-1.567-5.055c-.857-1.516-1.912-2.838-2.726-3.652l-.981-.981l-.62 1.24a6 6 0 0 0-.11.235a8.15 8.15 0 0 0-3.481-4.144l-1.26-.756z"
      />
    </svg>
  )
}


/** 无预览占位（🪧 画板） */
export function IconBoard(props: P): ReactElement {
  return (
    <svg {...base(props)}>
      <path
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
        d="M3 6h18M3 17h18M4 6v11M20 6v11M12 4v2M7 20l3-3h4l3 3"
      />
    </svg>
  )
}

/** 图片（🖼️ 发图按钮 / 图片评论） */
export function IconPic(props: P): ReactElement {
  return (
    <svg {...base(props)}>
      <path fill="currentColor" d="M16 8.5a.5.5 0 1 1-1 0a.5.5 0 0 1 1 0" />
      <path
        fill="currentColor"
        d="M14.121 14.879a1 1 0 1 0 1.415 1.414l-.708-.707zm2.829-1.415l.707-.707a1 1 0 0 0-1.414 0zm3.328 4.743a1 1 0 0 0 1.414-1.414l-.707.707zm-10.4-7.571l.708-.707a1 1 0 0 0-1.415 0zm5.158 6.571a1 1 0 0 0 1.414-1.414l-.707.707zM4 4v1h16V3H4zm17 1h-1v14h2V5zm-1 15v-1H4v2h16zM3 19h1V5H2v14zm11.828-3.414l.708.707l2.12-2.121l-.706-.708l-.707-.707l-2.122 2.122zm2.122-2.122l-.707.707l4.035 4.036l.707-.707l.707-.707l-4.035-4.036zm-7.071-2.828l-.707.707l5.864 5.864l.707-.707l.707-.707l-5.864-5.864zM3 17.515l.707.707l6.879-6.879l-.707-.707l-.707-.707l-6.88 6.879zM16 8.5h-1a.5.5 0 0 1 .5-.5v2A1.5 1.5 0 0 0 17 8.5zm-.5.5V8a.5.5 0 0 1 .5.5h-2a1.5 1.5 0 0 0 1.5 1.5zm-.5-.5h1a.5.5 0 0 1-.5.5V7A1.5 1.5 0 0 0 14 8.5zm.5-.5v1a.5.5 0 0 1-.5-.5h2A1.5 1.5 0 0 0 15.5 7zM4 20v-1H2a2 2 0 0 0 2 2zm17-1h-1v2a2 2 0 0 0 2-2zM20 4v1h2a2 2 0 0 0-2-2zM4 4V3a2 2 0 0 0-2 2h2z"
      />
    </svg>
  )
}

/** 关闭（✕） */
export function IconClose(props: P): ReactElement {
  return (
    <svg {...base(props)}>
      <path
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
        d="m5.636 5.637l12.728 12.728m-12.728 0L18.364 5.637"
      />
    </svg>
  )
}

/** 图钉（固定/取消固定；pinned=true 用 pin-fill 实心表「钉下」，false 用 pin-line 线条表「拔起」）。
    path 取自 MingCute 官方 pin-line / pin-fill（iconify API），与库内其他图标同源 */
export function IconPin({ pinned, ...props }: P & { pinned?: boolean }): ReactElement {
  return pinned ? (
    <svg {...base(props)}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M14.242 2.529a2 2 0 0 1 2.614.186l4.43 4.43a2 2 0 0 1 .186 2.614l-2.185 2.914a9 9 0 0 0-1.71 4.127l-.175 1.227a1.89 1.89 0 0 1-.969 1.413a1.78 1.78 0 0 1-1.772-.06c-1-.607-2.592-1.749-4.776-3.85l-4.249 4.25a1 1 0 0 1-1.414-1.415l4.25-4.25C6.37 11.933 5.226 10.34 4.621 9.34a1.78 1.78 0 0 1-.062-1.772a1.89 1.89 0 0 1 1.414-.97L7.2 6.425a9 9 0 0 0 4.127-1.71z"
      />
    </svg>
  ) : (
    <svg {...base(props)}>
      <path
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
        d="M9.879 14.122c2.508 2.509 4.275 3.781 5.3 4.402c.534.324 1.145-.02 1.233-.638l.175-1.227a10 10 0 0 1 1.9-4.586l2.185-2.914a1 1 0 0 0-.093-1.307l-4.43-4.43a1 1 0 0 0-1.307-.093l-2.914 2.185a10 10 0 0 1-4.586 1.9l-1.227.175c-.618.088-.962.7-.639 1.233c.622 1.025 1.894 2.792 4.403 5.3Zm0 0l-4.95 4.95"
      />
    </svg>
  )
}

/* ────────────────────────────────────────────────────────────────────────────
 * 内容源 / 状态图标（lucide 风格 stroke 线条；Control 页内容源 chips 用）
 * ──────────────────────────────────────────────────────────────────────────── */

/** 天气（云 + 太阳） */
export function IconWeather(props: P): ReactElement {
  return (
    <svg {...base(props)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="9" r="3.2" />
      <path d="M9 3.2v.9M9 13.9v.9M3.2 9h.9M13.9 9h.9M5 5l.6.6M12.4 12.4l.6.6M12.4 5.6l.6-.6M5 13l.6-.6" />
      <path d="M10.5 19a3.5 3.5 0 0 0 .4-6.98A4.5 4.5 0 0 0 6.6 15 3.5 3.5 0 0 0 7 19z" />
    </svg>
  )
}

/** 图表（用量+额度：三根柱） */
export function IconChart(props: P): ReactElement {
  return (
    <svg {...base(props)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </svg>
  )
}



/** 内置图库（装框画：山 + 太阳） */
export function IconImage(props: P): ReactElement {
  return (
    <svg {...base(props)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m4.5 17.5 4-4a1.5 1.5 0 0 1 2.1 0l5.9 5.9M14.5 15l2-2a1.5 1.5 0 0 1 2.1 0l1.9 1.9" />
    </svg>
  )
}

/** 我的图组（叠放的照片：两张错位） */
export function IconStack(props: P): ReactElement {
  return (
    <svg {...base(props)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="7" y="3.5" width="13.5" height="13.5" rx="2.5" />
      <path d="M16.5 17v2a2.5 2.5 0 0 1-2.5 2.5H5A2.5 2.5 0 0 1 2.5 19V10A2.5 2.5 0 0 1 5 7.5h2" />
    </svg>
  )
}

/** 分享（MingCute share）—— 系统分享面板入口 */
export function IconShare(props: P): ReactElement {
  return (
    <svg {...base(props)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12" />
      <path d="M8 6.5 12 3l4 3.5" />
      <path d="M5 13v5.5A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V13" />
    </svg>
  )
}

/** 自由画布（毛笔） */
export function IconBrush(props: P): ReactElement {
  return (
    <svg {...base(props)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.5 3.5c-2.5 0-6 1.5-8.5 4s-3.4 5-3.4 5l3 3s2.5-.9 5-3.4 4-6 4-8.5z" />
      <path d="M8.6 12.5C7 14 7 16 6 17.5c-.8 1.2-2 1.7-3.5 2 .5-3.5 1.2-6 2.5-7.5" />
    </svg>
  )
}

/** 自定义接口（插头 + 数据流） */
export function IconPlug(props: P): ReactElement {
  return (
    <svg {...base(props)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 7V3.5M15 7V3.5" />
      <path d="M6.5 7h11v3a5.5 5.5 0 0 1-11 0z" />
      <path d="M12 15.5v2M8.5 19.5c.9-.8 2.1-1.3 3.5-1.3s2.6.5 3.5 1.3" />
    </svg>
  )
}

/** 动画（场记板） */
export function IconFilm(props: P): ReactElement {
  return (
    <svg {...base(props)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 8.5v9a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-13a2 2 0 0 0-2 2z" />
      <path d="m3.5 9.5 17-3.2-.4-1.9a1.5 1.5 0 0 0-1.8-1.2L4 6.4a1.5 1.5 0 0 0-1.1 1.8zM8 6.9l1.5 2.6M12.5 6.1l1.5 2.6M17 5.3l1.5 2.6" />
      <path d="m10.5 12.5 4 2.5-4 2.5z" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** 本地图片（文件 + 缩略图） */
export function IconFileImage(props: P): ReactElement {
  return (
    <svg {...base(props)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" />
      <path d="M14 3.5V8.5h5" />
      <circle cx="9.5" cy="13" r="1.4" />
      <path d="m6.5 18 3-3a1.4 1.4 0 0 1 2 0l4.5 4.5" />
    </svg>
  )
}

/** 蓝牙（DeviceBadge / 连接条用） */
export function IconBluetooth(props: P): ReactElement {
  return (
    <svg {...base(props)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 7l10 9.5-5 4.5V3l5 4.5L7 17" />
    </svg>
  )
}

/** 加载中（旋转弧） */
/** 连接状态灯（三态）：connected 绿常亮 / connecting 琥珀 + ping 扩散动画 /
 *  disconnected 红 / idle 灰。全站共用（底栏灯 / DeviceBadge / Control hero）。 */
export function StatusDot({
  state,
  className = 'h-2 w-2',
}: {
  state: 'idle' | 'connecting' | 'connected' | 'disconnected'
  className?: string
}): ReactElement {
  if (state === 'connecting') {
    return (
      <span className={`relative inline-flex shrink-0 ${className}`} aria-hidden>
        {/* ping 扩散：里圈实心 + 外圈涟漪扩散，一眼看出「正在连接」 */}
        <span className="absolute inset-0 animate-ping rounded-full bg-amber-400/60" />
        <span className="relative inline-flex h-full w-full rounded-full bg-amber-400" />
      </span>
    )
  }
  const dot =
    state === 'connected'
      ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.9)]'
      : state === 'disconnected'
        ? 'bg-red-400'
        : 'bg-zinc-400'
  return <span className={`inline-block shrink-0 rounded-full ${dot} ${className}`} aria-hidden />
}

/** 底部 Tab 栏：首页（玻璃罩 logo 同源的展台） */
export function IconTabHome(props: P): ReactElement {
  return (
    <svg {...base(props)}>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 11.2 12 4.4l8 6.8V19a1.4 1.4 0 0 1-1.4 1.4h-3.3v-5.7h-6.6v5.7H5.4A1.4 1.4 0 0 1 4 19z"
      />
    </svg>
  )
}

/** 底部 Tab 栏：上传（向上箭头 + 底盘） */
export function IconTabUpload(props: P): ReactElement {
  return (
    <svg {...base(props)}>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 15.5V4.8m0 0L7.8 9M12 4.8 16.2 9M5 14.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3.5"
      />
    </svg>
  )
}

/** 底部 Tab 栏：用量（柱状图） */
export function IconTabUsage(props: P): ReactElement {
  return (
    <svg {...base(props)}>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        d="M5 20V14m7 6V4m7 16v-9"
      />
      <path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" d="M3.5 20h17" />
    </svg>
  )
}

/** 刷新（环形箭头） */
export function IconRefresh(props: P): ReactElement {
  return (
    <svg {...base(props)}>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M20 12a8 8 0 1 1-2.34-5.66M20 4.5V10h-5.5"
      />
    </svg>
  )
}

export function IconLoader(props: P): ReactElement {
  return (
    <svg {...base(props)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5" className="origin-center animate-spin [animation-duration:0.9s]" />
    </svg>
  )
}
