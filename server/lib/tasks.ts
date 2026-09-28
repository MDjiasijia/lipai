import type { TransferProgress, TransferStatus } from '../shared/index.js';

/** 长任务管理器(蓝牙传图用):EH 内存持状态,跨 webview 销毁复用,跨 EH 重启不保留。 */
interface TaskState {
  taskId: string;
  status: TransferStatus;
  done: number;
  total: number;
  error?: string;
  startedAt: number;
}

class TaskManager {
  private readonly tasks = new Map<string, TaskState>();
  private seq = 0;

  create(): TaskState {
    this.seq += 1;
    // taskId 用序号 + 时间戳(避免跨重启撞 id)。注意:不能用 Date.now()(EH 限制),
    // 用 process.uptime() 代替。
    const taskId = `img-${this.seq}-${Math.floor(process.uptime() * 1000)}`,
      state: TaskState = {
        taskId,
        status: 'running',
        done: 0,
        total: 0,
        startedAt: Date.now(),
      };
    this.tasks.set(taskId, state);
    return state;
  }

  get(taskId: string): TaskState | undefined {
    return this.tasks.get(taskId);
  }

  /** 更新进度并返回新的进度对象(供 emit)。 */
  update(
    taskId: string,
    patch: Partial<Pick<TaskState, 'done' | 'total' | 'status' | 'error'>>,
  ): TransferProgress | null {
    const state = this.tasks.get(taskId);
    if (!state) return null;
    Object.assign(state, patch);
    return {
      taskId: state.taskId,
      status: state.status,
      done: state.done,
      total: state.total,
      error: state.error,
    };
  }

  /** 列出所有 running 的任务(webview 挂载恢复用)。 */
  listPending(): TransferProgress[] {
    return [...this.tasks.values()]
      .filter((t) => t.status === 'running')
      .map((t) => ({
        taskId: t.taskId,
        status: t.status,
        done: t.done,
        total: t.total,
        error: t.error,
      }));
  }

  /** 清理已完成/失败超过 5 分钟的任务(避免内存泄漏)。 */
  gc(): void {
    const now = Date.now();
    for (const [id, t] of this.tasks) {
      if (t.status !== 'running' && now - t.startedAt > 5 * 60_000) {
        this.tasks.delete(id);
      }
    }
  }
}

export const taskManager = new TaskManager();
