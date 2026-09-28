/**
 * 全局工具类型。
 */

/** 任意函数签名（hooks 泛型约束用，避免 (...args: unknown[]) 丢参类型）。 */
type AnyFunction = (...args: any[]) => any

/** 无参无返回。 */
type NoneToVoidFunction = () => void

/** 任意入参、无返回（事件回调常见形态）。 */
type AnyToVoidFunction = (...args: any[]) => void
