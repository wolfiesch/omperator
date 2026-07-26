// Extract the top-level key set of OMP's `SETTINGS_SCHEMA` from a
// `settings-schema.ts` source file.
//
// The desktop config authority enumerates `Object.keys(SETTINGS_SCHEMA)`
// directly, so the schema's own top-level keys are exactly the paths it
// publishes.
//
// Detection is indentation-based: every entry sits at exactly one tab and the
// object terminates at a column-zero `};`. Brace-depth tracking was tried and
// rejected, because regex literals in the file carry quantifiers like `{40}`
// that unbalance the count and silently truncate the key set. Indentation is
// fragile against a reformat, so the parse is guarded: a missing terminator,
// a duplicate key, or an implausibly small result is reported as a failure
// rather than returned as data.

const SCHEMA_ANCHOR = /export const SETTINGS_SCHEMA[^=]*=\s*\{[^\n]*\n/u;
const ENTRY = /^\t(?:"([A-Za-z][\w.-]*)"|([A-Za-z][\w$]*))\s*:\s*\{/u;
const TERMINATOR = /^\}(?:\s+as\s+const)?\s*;?\s*$/u;
const MINIMUM_PLAUSIBLE_KEYS = 300;

/**
 * Drop `//` line comments and block comments so a commented-out entry never
 * counts, while leaving string contents alone.
 *
 * String awareness is not optional here: schema descriptions contain glob
 * patterns such as `src/**\/*.ts`, and a naive stripper reads the embedded
 * `/*` as a block-comment opener and swallows the rest of the file.
 */
function withoutComments(lines) {
  const out = [];
  let blockComment = false;
  for (const raw of lines) {
    let text = "";
    let quote = null;
    for (let index = 0; index < raw.length; index += 1) {
      const char = raw[index];
      if (blockComment) {
        if (char === "*" && raw[index + 1] === "/") {
          blockComment = false;
          index += 1;
        }
        continue;
      }
      if (quote) {
        text += char;
        if (char === "\\") {
          text += raw[index + 1] ?? "";
          index += 1;
        } else if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        text += char;
        continue;
      }
      if (char === "/" && raw[index + 1] === "/") break;
      if (char === "/" && raw[index + 1] === "*") {
        blockComment = true;
        index += 1;
        continue;
      }
      text += char;
    }
    out.push(text);
  }
  return out;
}
/**
 * @param {string} source contents of a `settings-schema.ts`
 * @returns {{ keys: string[], failures: string[] }} sorted keys, plus why a parse is untrustworthy
 */
export function settingsSchemaKeys(source) {
  const failures = [];
  const anchor = SCHEMA_ANCHOR.exec(source);
  if (!anchor) return { keys: [], failures: ["SETTINGS_SCHEMA declaration not found"] };

  const lines = withoutComments(source.slice(anchor.index + anchor[0].length).split("\n"));
  const keys = [];
  const seen = new Set();
  let terminated = false;

  for (const line of lines) {
    if (TERMINATOR.test(line)) {
      terminated = true;
      break;
    }
    const match = ENTRY.exec(line);
    if (!match) continue;
    const key = match[1] ?? match[2];
    if (seen.has(key)) failures.push(`duplicate schema key: ${key}`);
    seen.add(key);
    keys.push(key);
  }

  if (!terminated) failures.push("SETTINGS_SCHEMA object never terminated at column zero; parse is unreliable");
  if (keys.length < MINIMUM_PLAUSIBLE_KEYS)
    failures.push(`only ${keys.length} keys parsed; expected at least ${MINIMUM_PLAUSIBLE_KEYS}`);
  return { keys: keys.sort((a, b) => a.localeCompare(b)), failures };
}
