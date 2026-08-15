// 本地模型并发队列（2026-08-09，B4：本地 2 并发 + 排队超 60s 取消）
// - llama.cpp 单实例串行处理，多请求需排队；系统层限制并发，超时取消
// - 从 llm_config 读 concurrency / queue_timeout（管理员可调）
import { getDb } from '../db/index.js';

let active = 0;
const queue: { run: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];

function limits(): { concurrency: number; timeout: number } {
  const row = getDb().prepare('SELECT concurrency, queue_timeout FROM llm_config WHERE id=1').get() as any;
  return {
    concurrency: Math.max(1, Number(row?.concurrency ?? 2)),
    timeout: Math.max(1000, Number(row?.queue_timeout ?? 60000)),
  };
}

/** 排队执行（本地模式 LLM 调用包裹）：并发超限排队，排队超时拒绝（请求方应降级/报繁忙） */
export function runWithLocalQueue<T>(fn: () => Promise<T>): Promise<T> {
  const { concurrency, timeout } = limits();
  if (active < concurrency) {
    active++;
    return fn().finally(() => { active--; pump(); });
  }
  // 排队
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = queue.indexOf(entry);
      if (i >= 0) queue.splice(i, 1);
      reject(new Error(`本地模型繁忙：排队超过 ${Math.round(timeout / 1000)}s，请稍后再试`));
    }, timeout);
    const entry = {
      run: () => {
        clearTimeout(timer);
        active++;
        fn().finally(() => { active--; pump(); }).then(resolve, reject);
      },
      reject,
      timer,
    };
    queue.push(entry);
  });
}

function pump(): void {
  const { concurrency } = limits();
  while (queue.length && active < concurrency) {
    const next = queue.shift();
    if (next) next.run();
  }
}

/** 当前排队状态（状态面板/调试用） */
export function localQueueStatus(): { active: number; waiting: number } {
  return { active, waiting: queue.length };
}
