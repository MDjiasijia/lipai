/**
 * 事件总线 + SSE 广播。
 *
 * 多客户端场景(多个浏览器标签/手机):订阅者集合 + 广播。logBuffer 是全量日志
 * 环形缓冲:SSE 重连后客户端可以带 ?since=<ts> 拉增量,页面刷新不丢历史。
 */
import type { LogEntry } from './shared/index.js';

export const LOG_BUFFER_MAX = 400;
export const logBuffer: LogEntry[] = [];

type EventHandler = (event: string, data: unknown) => void;
const subscribers = new Set<EventHandler>();

/** SSE 等订阅者注册;返回退订函数。 */
export function subscribe(handler: EventHandler): () => void {
  subscribers.add(handler);
  return () => subscribers.delete(handler);
}

/** 广播一个事件给所有订阅者(SSE 写失败时由订阅方自摘除)。 */
export function emit(event: string, data: unknown): void {
  for (const handler of subscribers) {
    try {
      handler(event, data);
    } catch {
      // 订阅方已死(SSE 断开):下一轮 GC;SSE 路由自己会清。
      subscribers.delete(handler);
    }
  }
}

/** 把事件格式化成 SSE 帧(`event: x\ndata: {...}\n\n`)。 */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
