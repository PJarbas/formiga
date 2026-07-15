// ══════════════════════════════════════════════════════════════════════
// background-queue.test.ts — Unit tests for BackgroundQueue
// ══════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BackgroundQueue } from "../../queue/background-queue.js";

describe("BackgroundQueue", () => {
  let queue: BackgroundQueue;

  beforeEach(() => {
    queue = new BackgroundQueue();
  });

  afterEach(async () => {
    await queue.shutdown(100);
  });

  describe("enqueue", () => {
    it("processes tasks asynchronously", async () => {
      const results: number[] = [];

      queue.enqueue(async () => {
        results.push(1);
      });
      queue.enqueue(async () => {
        results.push(2);
      });
      queue.enqueue(async () => {
        results.push(3);
      });

      await queue.shutdown();

      expect(results).toEqual([1, 2, 3]);
    });

    it("does not block the caller", () => {
      const start = Date.now();

      queue.enqueue(async () => {
        await new Promise((r) => setTimeout(r, 100));
      });

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(50);
    });

    it("reports pending count correctly", () => {
      expect(queue.pending).toBe(0);

      for (let i = 0; i < 5; i++) {
        queue.enqueue(async () => {
          await new Promise((r) => setTimeout(r, 50));
        });
      }

      expect(queue.pending).toBeGreaterThan(0);
    });
  });

  describe("error handling", () => {
    it("continues processing after task failure", async () => {
      const results: string[] = [];

      queue.enqueue(async () => {
        throw new Error("Task 1 failed");
      });
      queue.enqueue(async () => {
        results.push("success");
      });

      await queue.shutdown();

      expect(results).toEqual(["success"]);
    });

    it("logs errors but does not throw", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      queue.enqueue(async () => {
        throw new Error("Test error");
      });

      await queue.shutdown();

      consoleSpy.mockRestore();
    });
  });

  describe("shutdown", () => {
    it("waits for pending tasks to complete", async () => {
      const results: number[] = [];

      queue.enqueue(async () => {
        await new Promise((r) => setTimeout(r, 50));
        results.push(1);
      });

      await queue.shutdown(500);

      expect(results).toEqual([1]);
    });

    it("respects timeout and stops waiting", async () => {
      queue.enqueue(async () => {
        await new Promise((r) => setTimeout(r, 1000));
      });

      const start = Date.now();
      await queue.shutdown(100);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(500);
    });

    it("rejects new tasks after shutdown starts", async () => {
      const results: number[] = [];

      const shutdownPromise = queue.shutdown(50);

      queue.enqueue(async () => {
        results.push(1);
      });

      await shutdownPromise;

      expect(results).toEqual([]);
    });
  });

  describe("queue limits", () => {
    it("drops oldest task when queue is full", async () => {
      const largeQueue = new BackgroundQueue(5);
      const executedTasks: number[] = [];

      for (let i = 0; i < 10; i++) {
        const taskNum = i;
        largeQueue.enqueue(async () => {
          await new Promise((r) => setTimeout(r, 20));
          executedTasks.push(taskNum);
        });
      }

      await largeQueue.shutdown(2000);

      expect(executedTasks.length).toBeLessThanOrEqual(6);
      expect(largeQueue.pending).toBe(0);
    });
  });
});
