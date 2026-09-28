/**
 * ips 领域类型收口转发 —— 真相源在 shared.ts（前后端共享、纯 TS）。
 *
 * share-web 版这里曾是独立定义；本地版收口成转发（与 src/types.ts 的
 * SlotSource 收口规则同源）：本文件保留 DeviceInfo / LogEntry 的 import 路径，
 * device.ts / LogDock.tsx 等既有消费方不感知。
 */
export type { DeviceInfo, LogEntry, TransferProgress, TransferStatus, LoopState, SlotApplyState } from './shared'
