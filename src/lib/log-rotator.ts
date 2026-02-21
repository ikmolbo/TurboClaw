/**
 * Size-based log rotation.
 *
 * Writes lines to a log file and rotates when it exceeds maxSize.
 * Rotated files are named: <file>.1, <file>.2, ... up to maxFiles.
 */

import fs from "fs";
import path from "path";

export interface LogRotatorOptions {
  /** Path to the log file */
  filePath: string;
  /** Maximum file size in bytes before rotating (default: 5MB) */
  maxSize?: number;
  /** Number of rotated files to keep (default: 3) */
  maxFiles?: number;
}

const DEFAULT_MAX_SIZE = 5 * 1024 * 1024; // 5MB
const DEFAULT_MAX_FILES = 3;

export class LogRotator {
  readonly filePath: string;
  readonly maxSize: number;
  readonly maxFiles: number;
  private fd: number;
  private currentSize: number;

  constructor(options: LogRotatorOptions) {
    this.filePath = options.filePath;
    this.maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;

    // Ensure directory exists
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    // Open file for appending, get current size
    this.fd = fs.openSync(this.filePath, "a");
    try {
      this.currentSize = fs.fstatSync(this.fd).size;
    } catch {
      this.currentSize = 0;
    }
  }

  /**
   * Write a line to the log file, rotating if necessary.
   */
  write(line: string): void {
    const buf = Buffer.from(line + "\n", "utf-8");

    if (this.currentSize + buf.length > this.maxSize) {
      this.rotate();
    }

    fs.writeSync(this.fd, buf);
    this.currentSize += buf.length;
  }

  /**
   * Close the file descriptor.
   */
  close(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      // ignore
    }
  }

  private rotate(): void {
    // Close current fd before renaming
    fs.closeSync(this.fd);

    // Shift existing rotated files: .3 → deleted, .2 → .3, .1 → .2, current → .1
    for (let i = this.maxFiles; i >= 1; i--) {
      const src = i === 1 ? this.filePath : `${this.filePath}.${i - 1}`;
      const dst = `${this.filePath}.${i}`;

      try {
        if (i === this.maxFiles) {
          // Delete the oldest
          fs.unlinkSync(dst);
        }
      } catch {
        // File may not exist
      }

      try {
        fs.renameSync(src, dst);
      } catch {
        // Source may not exist
      }
    }

    // Re-open a fresh file
    this.fd = fs.openSync(this.filePath, "a");
    this.currentSize = 0;
  }
}
