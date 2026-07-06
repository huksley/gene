/**
 * System-clipboard bridge for the TUI's drag-selection copy (app.ts).
 *
 * OSC 52 alone isn't enough: the renderer only emits it when the terminal
 * advertises support, and common local terminals either don't implement it at
 * all (macOS Terminal.app) or ship with it disabled (iTerm2's "allow clipboard
 * access"). So — like opencode's tui clipboard — we drive both paths: a
 * best-effort OSC 52 through the renderer (covers SSH, where the local OS
 * clipboard is unreachable) plus the platform clipboard tool, which is the one
 * that actually works locally. The copy counts as done when either succeeds.
 *
 * OSC 52 goes through the renderer rather than a raw stdout write so the escape
 * sequence can't interleave with a frame the native layer is mid-writing.
 */

import { spawn } from "node:child_process";

import type { CliRenderer } from "@opentui/core";

/** Pipe `text` into a clipboard command; false on any failure (missing tool, non-zero exit). */
const pipeTo = (command: string, args: string[], text: string, env?: NodeJS.ProcessEnv): Promise<boolean> =>
  new Promise(resolve => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], env });
    child.on("error", () => resolve(false)); // ENOENT — the tool isn't installed
    child.on("close", code => resolve(code === 0));
    child.stdin.on("error", () => {}); // EPIPE from a dying child; "close" still settles the promise
    child.stdin.end(text);
  });

/**
 * Run the platform clipboard tool: pbcopy (macOS) / wl-copy / xclip / xsel (Linux,
 * tried in turn — on a headless/SSH box they all fail and OSC 52 is the right path
 * anyway). No Windows branch: Gene only ships macOS/Linux builds.
 */
const nativeCopy = async (text: string): Promise<boolean> => {
  if (process.platform === "darwin") {
    // Pin LC_CTYPE rather than trusting the ambient locale: pbcopy mangles
    // non-ASCII (the table's glyphs, branch names…) under a non-UTF-8 LANG.
    return pipeTo("pbcopy", [], text, { ...process.env, LC_CTYPE: "UTF-8" });
  }
  if (process.platform === "linux") {
    if (process.env.WAYLAND_DISPLAY && (await pipeTo("wl-copy", [], text))) {
      return true;
    }
    if (await pipeTo("xclip", ["-selection", "clipboard"], text)) {
      return true;
    }
    return pipeTo("xsel", ["--clipboard", "--input"], text);
  }
  return false;
};

/** Copy `text` to the system clipboard; true when any path succeeded. Never throws. */
export const copyToClipboard = async (renderer: CliRenderer, text: string): Promise<boolean> => {
  let osc = false;
  try {
    // Returns false (without writing) when the terminal doesn't advertise OSC 52.
    osc = renderer.copyToClipboardOSC52(text);
  } catch {
    // FFI hiccup — the native tool below still covers the local case.
  }
  return (await nativeCopy(text)) || osc;
};
