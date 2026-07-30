// render.ts — cell-grid ANSI renderer for the t4 TUI. No dependencies: the
// whole frame is composed into one buffer per redraw and diffed by line so
// updates stay flicker-free even on slow links.
import { FG, palette, RESET } from "./theme.ts";

export interface Cell {
  text: string;
  fg?: number;
  bold?: boolean;
  dim?: boolean;
}

/** Strip terminal control bytes from host-provided text before rendering it. */
export function terminalSafeText(text: string): string {
  let safe = "";
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    safe += character;
  }
  return safe;
}

export class Screen {
  cols = 80;
  rows = 24;
  private lines: string[] = [];
  private prevLines: string[] = [];

  enter() {
    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J");
    this.resize();
  }
  exit() {
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  }
  resize() {
    this.cols = Math.max(40, process.stdout.columns ?? 80);
    this.rows = Math.max(10, process.stdout.rows ?? 24);
  }

  /** Write styled text into a line buffer at column x (clipped). */
  private put(buf: string, x: number, cells: Cell[]): string {
    for (const cell of cells) {
      if (x >= this.cols) break;
      const clipped = terminalSafeText(cell.text).slice(0, this.cols - x);
      const style = `${cell.fg !== undefined ? FG(cell.fg) : ""}${cell.bold ? "\x1b[1m" : ""}${cell.dim ? "\x1b[2m" : ""}`;
      buf += `${style}${clipped}${RESET}`;
      x += clipped.length;
    }
    return buf;
  }

  line(cells: Cell[]): void {
    this.lines.push(this.put("", 0, cells));
  }
  blank(): void {
    this.lines.push("");
  }
  /** Horizontal rule across the full width. */
  rule(fg = palette.line): void {
    this.lines.push(FG(fg) + "─".repeat(this.cols) + RESET);
  }
  /** Pad remaining rows so the frame fills the screen (prevents artifacts). */
  finish(): void {
    while (this.lines.length < this.rows) this.lines.push("");
    this.lines.length = Math.min(this.lines.length, this.rows);
    // Diff against the previous frame: only move+rewrite changed lines.
    let out = "";
    for (let y = 0; y < this.lines.length; y += 1) {
      if (this.lines[y] !== this.prevLines[y]) out += `\x1b[${y + 1};1H${this.lines[y]}\x1b[K`;
    }
    this.prevLines = this.lines;
    this.lines = [];
    process.stdout.write(out);
  }
}

/** Word-wrap text to width, preserving words; returns wrapped lines. */
export function wrap(text: string, width: number): string[] {
  if (width < 8) return [text];
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    let line = raw;
    while (line.length > width) {
      let cut = line.lastIndexOf(" ", width);
      if (cut < Math.floor(width * 0.4)) cut = width;
      out.push(line.slice(0, cut));
      line = line.slice(cut).trimStart();
    }
    out.push(line);
  }
  return out;
}

/** Visible-length truncate with ellipsis. */
export function clip(text: string, width: number): string {
  if (width <= 1) return "";
  return text.length > width ? text.slice(0, width - 1) + "…" : text.padEnd(width);
}
