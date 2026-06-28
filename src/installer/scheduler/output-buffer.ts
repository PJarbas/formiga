// ══════════════════════════════════════════════════════════════════════
// output-buffer.ts — Bounded ring buffer for pi/hermes stdout
// ══════════════════════════════════════════════════════════════════════
//
// Replaces unbounded in-memory accumulation of child process stdout.
// Keeps only the most recent N bytes, evicting oldest lines when full.
//
// Design principles:
//   - stdout is an observability stream, not a data transport channel
//   - Agents report results via `formiga step complete` (API/CLI)
//   - The scheduler only needs stdout for:
//     1. Token metadata extraction (JSON envelope at end of output)
//     2. Outcome classification (heartbeat vs work_done)
//     3. Fallback auto-complete (safety net when agent didn't self-report)
//   - All of the above only require the TAIL of the output
//
// Memory guarantee: O(maxBytes) regardless of pi output size.
// ══════════════════════════════════════════════════════════════════════

/**
 * A bounded ring buffer that retains only the most recent lines up to
 * a configurable byte limit. Older lines are evicted FIFO when the
 * buffer exceeds capacity.
 *
 * This ensures predictable memory usage regardless of how much output
 * the harness process produces.
 */
export class OutputRingBuffer {
  private chunks: string[] = [];
  private currentBytes = 0;
  private readonly maxBytes: number;
  private _totalBytesIngested = 0;
  private _linesDropped = 0;

  constructor(maxBytes = 1024 * 1024) {
    this.maxBytes = maxBytes;
  }

  /** Append a line to the buffer, evicting oldest lines if over capacity. */
  push(line: string): void {
    const lineBytes = Buffer.byteLength(line, "utf-8") + 1; // +1 for newline
    this._totalBytesIngested += lineBytes;

    // If a single line exceeds the entire buffer, truncate it
    if (lineBytes > this.maxBytes) {
      const truncated = line.slice(0, this.maxBytes - 64) + " [… truncated]";
      this.chunks = [truncated];
      this.currentBytes = Buffer.byteLength(truncated, "utf-8") + 1;
      this._linesDropped++;
      return;
    }

    this.chunks.push(line);
    this.currentBytes += lineBytes;

    // Evict oldest lines until within capacity
    while (this.currentBytes > this.maxBytes && this.chunks.length > 1) {
      const removed = this.chunks.shift()!;
      this.currentBytes -= Buffer.byteLength(removed, "utf-8") + 1;
      this._linesDropped++;
    }
  }

  /** Get the buffered output as a single string. */
  toString(): string {
    return this.chunks.join("\n");
  }

  /** Number of lines currently in the buffer. */
  get lineCount(): number {
    return this.chunks.length;
  }

  /** Current buffer size in bytes. */
  get byteSize(): number {
    return this.currentBytes;
  }

  /** Total bytes ingested (including evicted). */
  get totalBytesIngested(): number {
    return this._totalBytesIngested;
  }

  /** Number of lines that were evicted to stay within capacity. */
  get linesDropped(): number {
    return this._linesDropped;
  }

  /** Whether any lines were dropped (output was truncated). */
  get wasTruncated(): boolean {
    return this._linesDropped > 0;
  }
}
