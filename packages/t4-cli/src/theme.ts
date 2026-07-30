// theme.ts — T4 palette for 24-bit ANSI. Mirrors apps/ios Theme.swift (Rosé
// Pine lineage) so the TUI reads as the same product as the native apps.
export const rgb = (hex: number): [number, number, number] => [
  (hex >> 16) & 0xff,
  (hex >> 8) & 0xff,
  hex & 0xff,
];

export const FG = (hex: number) => {
  const [r, g, b] = rgb(hex);
  return `\x1b[38;2;${r};${g};${b}m`;
};
export const BG = (hex: number) => {
  const [r, g, b] = rgb(hex);
  return `\x1b[48;2;${r};${g};${b}m`;
};

export const palette = {
  bg: 0x000000,
  panel: 0x0c0c0e,
  ink: 0xffffff,
  body: 0xcccccc, // white 80%
  muted: 0x949494, // white 58%
  label: 0x666666, // white 40%
  ghost: 0x404040, // white 25%
  line: 0x262626, // white 15%
  accent: 0xc8d6e5, // periwinkle
  gold: 0xf6c177,
  foam: 0x7fd6c8,
  iris: 0xb9a3e3,
  pine: 0x7bb8d4,
  love: 0xe8919f,
  ok: 0x86e0b0,
} as const;

export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const DIM = "\x1b[2m";
export const ITALIC = "\x1b[3m";
export const INVERT = "\x1b[7m";

/** fg(hex) + text + reset */
export const c = (hex: number, text: string) => `${FG(hex)}${text}${RESET}`;
/** Status-color by session status string (mirrors StatusPill). */
export function statusColor(status: string): number {
  switch (status) {
    case "working":
    case "running":
      return palette.foam;
    case "attention":
    case "blocked":
      return palette.gold;
    case "error":
      return palette.love;
    default:
      return palette.muted;
  }
}
