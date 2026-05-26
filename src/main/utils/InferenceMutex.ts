/**
 * InferenceMutex
 * 负责前后台推理任务的非阻塞并发互斥锁。
 * 
 * 当用户正在与前台角色进行流式聊天 (主模型调用) 时，
 * 锁定该互斥锁，阻塞或延后后台长期记忆及专属偏好的静默提炼 (辅助模型调用)，
 * 彻底消除打字机渲染卡顿，并严防 Trip 大模型 API 的 429 并发频限限制。
 */
export class InferenceMutex {
  private static locked = false;
  private static waiters: (() => void)[] = [];

  /**
   * 尝试获取并发锁。
   * 若锁已被占用，则返回一个挂起的 Promise 并推入排队队列，直到被释放后才 resolve 激活。
   */
  public static async lock(): Promise<void> {
    if (this.locked) {
      return new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
    this.locked = true;
  }

  /**
   * 释放并发锁。
   * 自动按顺序 (FIFO) 唤醒并放行队列中下一个等待的任务。
   */
  public static unlock(): void {
    if (!this.locked) {
      return;
    }
    this.locked = false;
    const next = this.waiters.shift();
    if (next) {
      this.locked = true; // 原子化地将锁直接递交给下一个等待的任务，防止插队
      next();
    }
  }

  /**
   * 查看当前并发锁是否处于锁定状态
   */
  public static isLocked(): boolean {
    return this.locked;
  }

  /**
   * 强制重置清除并发锁状态及排队队列 (主要用于单测重置)
   */
  public static reset(): void {
    this.locked = false;
    this.waiters = [];
  }
}
