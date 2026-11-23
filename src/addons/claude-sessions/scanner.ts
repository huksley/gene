/**
 * Read Claude Code's local state: the live-session registry (`sessions/<pid>.json`) and
 * the transcripts (`projects/<dir>/<sessionId>.jsonl`).
 *
 * Transcripts are large (megabytes each) and append-only while a session runs, so each
 * file is read incrementally: the scanner remembers how far it got and on the next pass
 * reads only the bytes appended since. A file that shrank or was replaced is re-read from
 * the start. Only files touched within the window are opened at all.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ingest, newSession, type SessionAcc } from "./parse.ts";

/** `$CLAUDE_CONFIG_DIR`, else `~/.claude` — where Claude Code keeps its state. */
export const claudeRoot = (): string => {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".claude");
};

export type LiveSession = { pid: number; sessionId: string; cwd?: string; status: string; name?: string; since?: number; kind?: string };

/** Whether a pid from the registry is a running process on this machine. */
const alive = (pid: number, domain: unknown): boolean => {
  // A registry entry written inside a container/VM (pidDomain "linux::pid:[…]" on a Mac)
  // names a pid in another namespace — it says nothing about this machine's processes.
  if (typeof domain === "string" && !domain.startsWith(process.platform)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Sessions a running Claude Code process holds right now. */
export const readLiveSessions = async (root: string): Promise<LiveSession[]> => {
  const dir = path.join(root, "sessions");
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: LiveSession[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue; // the .key files beside them are secrets — never read
    try {
      const rec = JSON.parse(await fs.readFile(path.join(dir, name), "utf-8"));
      const pid = Number(rec.pid);
      if (!Number.isInteger(pid) || typeof rec.sessionId !== "string" || !alive(pid, rec.pidDomain)) continue;
      out.push({
        pid,
        sessionId: rec.sessionId,
        cwd: rec.cwd,
        status: typeof rec.status === "string" ? rec.status : "unknown",
        name: rec.name,
        since: typeof rec.startedAt === "number" ? rec.startedAt : undefined,
        kind: rec.kind
      });
    } catch {
      // half-written or foreign file — skip
    }
  }
  return out;
};

type FileState = { ino: number; offset: number; remainder: Buffer; acc: SessionAcc };

const CHUNK = 4 * 1024 * 1024;
const NEWLINE = 0x0a;

export class TranscriptScanner {
  private files = new Map<string, FileState>();
  private readonly root: string;

  // No parameter properties: Node runs this file by stripping types, which they'd need emitted.
  constructor(root: string) {
    this.root = root;
  }

  /** Every transcript touched since `sinceMs`: [project dir, file] pairs. */
  private async list(sinceMs: number): Promise<{ file: string; mtimeMs: number }[]> {
    const projects = path.join(this.root, "projects");
    let dirs: string[];
    try {
      dirs = await fs.readdir(projects);
    } catch {
      return [];
    }
    const out: { file: string; mtimeMs: number }[] = [];
    for (const dir of dirs) {
      let names: string[];
      try {
        names = await fs.readdir(path.join(projects, dir));
      } catch {
        continue;
      }
      // Top-level transcripts only — `<sessionId>/subagents/*.jsonl` are a session's subagents.
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const file = path.join(projects, dir, name);
        try {
          const st = await fs.stat(file);
          if (st.isFile() && st.mtimeMs >= sinceMs) out.push({ file, mtimeMs: st.mtimeMs });
        } catch {
          // vanished between readdir and stat
        }
      }
    }
    return out;
  }

  /** Read what was appended to one transcript since the last pass. */
  private async advance(file: string): Promise<void> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(file, "r");
    } catch {
      this.files.delete(file);
      return;
    }
    try {
      const st = await handle.stat();
      let state = this.files.get(file);
      if (!state || state.ino !== st.ino || st.size < state.offset) {
        state = { ino: st.ino, offset: 0, remainder: Buffer.alloc(0), acc: newSession(path.basename(file, ".jsonl")) };
        this.files.set(file, state);
      }
      while (state.offset < st.size) {
        const length = Math.min(CHUNK, st.size - state.offset);
        const buf = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buf, 0, length, state.offset);
        if (bytesRead === 0) break;
        state.offset += bytesRead;
        // Split on raw newlines so a multibyte character is never cut in half.
        const data = state.remainder.length ? Buffer.concat([state.remainder, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        let start = 0;
        for (let nl = data.indexOf(NEWLINE, start); nl !== -1; nl = data.indexOf(NEWLINE, start)) {
          this.line(state.acc, data.subarray(start, nl));
          start = nl + 1;
        }
        state.remainder = Buffer.from(data.subarray(start));
        // Yield between chunks: a cold scan of a big transcript must not stall the daemon.
        await new Promise(resolve => setImmediate(resolve));
      }
    } finally {
      await handle.close();
    }
  }

  private line(acc: SessionAcc, raw: Buffer): void {
    if (raw.length < 2) return;
    try {
      ingest(acc, JSON.parse(raw.toString("utf-8")));
    } catch {
      // a torn or non-JSON line — skip it
    }
  }

  /**
   * Bring every transcript touched since `sinceMs` up to date and return their sessions.
   * Parsed state is kept for files touched since `retainSinceMs` (so narrowing the window
   * and widening it again doesn't re-read them) and dropped for older ones.
   */
  async scan(sinceMs: number, retainSinceMs: number = sinceMs): Promise<SessionAcc[]> {
    const files = await this.list(Math.min(sinceMs, retainSinceMs));
    const retained = new Set(files.map(f => f.file));
    for (const file of this.files.keys()) if (!retained.has(file)) this.files.delete(file);
    const inWindow = files.filter(f => f.mtimeMs >= sinceMs);
    for (const { file } of inWindow) await this.advance(file);
    return inWindow.map(f => this.files.get(f.file)?.acc).filter((a): a is SessionAcc => a !== undefined);
  }
}
