// ══════════════════════════════════════════════════════════════════════
// background-queue.ts — Fire-and-forget task queue for non-blocking I/O
// ══════════════════════════════════════════════════════════════════════

import type { IBackgroundQueue } from "../types.js";
import { logger } from "../../lib/logger.js";

/**
 * Non-blocking background queue that processes tasks sequentially.
 *
 * Design principles:
 * - Fire-and-forget: enqueue() returns immediately
 * - Graceful degradation: errors don't stop processing
 * - Bounded memory: drops oldest tasks when full
 * - Clean shutdown: waits for pending tasks with timeout
 */
export class BackgroundQueue implements IBackgroundQueue {
  private readonly queue: Array<() => Promise<void>> = [];
  private readonly maxSize: number;
  private processing = false;
  private shuttingDown = false;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  /**
   * Number of pending tasks in the queue
   */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Enqueue a task for background processing.
   * Returns immediately (fire-and-forget).
   */
  enqueue(task: () => Promise<void>): void {
    if (this.shuttingDown) {
      logger.debug("BackgroundQueue: task rejected, shutting down");
      return;
    }

    if (this.queue.length >= this.maxSize) {
      this.queue.shift();
      logger.warn("BackgroundQueue: queue full, dropped oldest task", {
        maxSize: this.maxSize,
      });
    }

    this.queue.push(task);
    this.processNext();
  }

  /**
   * Process the next task in the queue.
   * Uses setImmediate to avoid blocking the event loop.
   */
  private processNext(): void {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;
    const task = this.queue.shift()!;

    // Use Promise to handle async task
    task()
      .catch((error) => {
        logger.error("BackgroundQueue: task failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.processing = false;
        // Schedule next task on next tick to avoid stack overflow
        setImmediate(() => this.processNext());
      });
  }

  /**
   * Graceful shutdown: wait for pending tasks with timeout.
   * @param timeoutMs Maximum time to wait (default: 5000ms)
   */
  async shutdown(timeoutMs = 5000): Promise<void> {
    this.shuttingDown = true;

    if (this.queue.length === 0 && !this.processing) {
      return;
    }

    const deadline = Date.now() + timeoutMs;

    while ((this.queue.length > 0 || this.processing) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (this.queue.length > 0) {
      logger.warn("BackgroundQueue: shutdown timeout, dropped remaining tasks", {
        dropped: this.queue.length,
      });
      this.queue.length = 0;
    }
  }
}
