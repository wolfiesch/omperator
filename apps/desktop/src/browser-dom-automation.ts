const MAX_STRING_BYTES = 32 * 1024;
const MAX_ELEMENTS = 512;
const MAX_SNAPSHOT_ELEMENTS = 256;
const MAX_DEPTH = 12;
const MAX_TIMEOUT_MS = 30_000;
const MAX_SCRIPT_BYTES = 64 * 1024;

type ErrorCode = "invalid_params" | "not_found" | "invalid_state" | "not_supported" | "timeout" | "security" | "internal";

export class BrowserDomAutomationError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "BrowserDomAutomationError";
    this.code = code;
  }
}

type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };
interface RefEntry { readonly ref: string; readonly element: Element; }
interface SnapshotElement {
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  readonly visible: true;
  readonly text?: string;
  readonly value?: string;
  readonly bounds?: { x: number; y: number; width: number; height: number };
  readonly disabled?: boolean;
  readonly checked?: boolean;
  readonly expanded?: boolean;
  readonly children?: readonly SnapshotElement[];
}

const refs = new Map<string, RefEntry>();
const elements = new WeakMap<Element, string>();
let nextRef = 1;
let activeDocument: Document | null = null;
let designModeOriginals = new WeakMap<Document, string>();
const designModeDocuments = new Set<Document>();
let savedState: JsonValue | null = null;
const dialogQueue: Array<{ type: "alert" | "confirm" | "prompt"; message: string; defaultValue?: string }> = [];
let dialogInstalled = false;

const encoder = new TextEncoder();
function bytes(value: string): number { return encoder.encode(value).byteLength; }
function bound(value: string, limit = MAX_STRING_BYTES): string {
  if (bytes(value) <= limit) return value;
  let end = value.length;
  while (end > 0 && bytes(value.slice(0, end)) > limit) end -= 1;
  return value.slice(0, end);
}
function text(value: unknown, name: string, limit = MAX_STRING_BYTES): string {
  if (typeof value !== "string" || bytes(value) > limit) throw new BrowserDomAutomationError("invalid_params", `${name} must be bounded text`);
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new BrowserDomAutomationError("invalid_params", "params must be an object");
  return value as Record<string, unknown>;
}
function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(-32768, Math.min(32768, value)) : fallback;
}
function documentRoot(): Document {
  if (typeof document === "undefined") throw new BrowserDomAutomationError("invalid_state", "Document is unavailable");
  return activeDocument ?? document;
}
function rootElement(): Element { return documentRoot().documentElement; }
function roleFor(element: Element): string {
  const explicit = element.getAttribute("role");
  if (explicit) return bound(explicit, 128);
  const tag = element.tagName.toLowerCase();
  if (tag === "a" && element.hasAttribute("href")) return "link";
  if (tag === "button") return "button";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  if (tag === "img") return "img";
  if (tag === "input") return (element as HTMLInputElement).type === "checkbox" ? "checkbox" : (element as HTMLInputElement).type === "radio" ? "radio" : "textbox";
  if (/^h[1-6]$/u.test(tag)) return "heading";
  if (tag === "nav") return "navigation";
  if (tag === "main") return "main";
  if (tag === "form") return "form";
  if (tag === "ul" || tag === "ol") return "list";
  if (tag === "li") return "listitem";
  return tag === "body" ? "document" : "generic";
}
function accessibleName(element: Element): string {
  const aria = element.getAttribute("aria-label");
  if (aria) return bound(aria);
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) return bound(labelledBy.split(/\s+/u).map((id) => documentRoot().getElementById(id)?.textContent ?? "").join(" ").trim());
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    if (element.id) {
      const label = documentRoot().querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (label) return bound(label.textContent?.trim() ?? "");
    }
    const placeholder = element.getAttribute("placeholder");
    if (placeholder) return bound(placeholder);
  }
  if (element instanceof HTMLImageElement && element.alt) return bound(element.alt);
  const tag = element.tagName.toLowerCase();
  const textNamedElement =
    tag === "a" ||
    tag === "button" ||
    /^h[1-6]$/u.test(tag) ||
    element.children.length === 0;
  return textNamedElement
    ? bound((element.textContent ?? "").replace(/\s+/gu, " ").trim(), 8_192)
    : "";
}
function elementRef(element: Element): string {
  const old = elements.get(element);
  if (old && refs.get(old)?.element === element) return old;
  const ref = `@e${nextRef++}`;
  elements.set(element, ref);
  refs.set(ref, { ref, element });
  return ref;
}
function checkRef(ref: unknown): Element {
  if (typeof ref !== "string" || !/^@e[1-9][0-9]{0,8}$/u.test(ref)) throw new BrowserDomAutomationError("not_found", "Element reference was not found");
  const entry = refs.get(ref);
  if (!entry || !entry.element.isConnected || (activeDocument && entry.element.ownerDocument !== activeDocument)) throw new BrowserDomAutomationError("not_found", "Element reference was not found");
  return entry.element;
}
function target(params: Record<string, unknown>, required = true): Element | null {
  if (params.ref !== undefined) return checkRef(params.ref);
  if (params.selector !== undefined) {
    const selector = text(params.selector, "selector", 4_096);
    try {
      const found = documentRoot().querySelector(selector);
      if (!found) throw new BrowserDomAutomationError("not_found", "Selector did not match an element");
      return found;
    } catch (error) {
      if (error instanceof BrowserDomAutomationError) throw error;
      throw new BrowserDomAutomationError("invalid_params", "Invalid selector");
    }
  }
  if (required) throw new BrowserDomAutomationError("invalid_params", "ref or selector is required");
  return null;
}
function all(selector: string): Element[] {
  try { return Array.from(documentRoot().querySelectorAll(selector)).slice(0, MAX_ELEMENTS); }
  catch { throw new BrowserDomAutomationError("invalid_params", "Invalid selector"); }
}
function boundsOf(element: Element): { x: number; y: number; width: number; height: number } {
  const rect = element.getBoundingClientRect();
  return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
}
function isVisible(element: Element): boolean {
  if (!element.isConnected) return false;
  const view = element.ownerDocument.defaultView ?? window;
  let current: Element | null = element;
  while (current !== null) {
    const style = view.getComputedStyle(current);
    if (
      current.hasAttribute("hidden") ||
      current.getAttribute("aria-hidden") === "true" ||
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      Number(style.opacity) === 0
    ) {
      return false;
    }
    current = current.parentElement;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
function isDisabled(element: Element): boolean {
  return (element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled === true || element.getAttribute("aria-disabled") === "true" || element.closest("fieldset[disabled]") !== null;
}
function snapshotNode(element: Element, depth: number, budget: { count: number }): SnapshotElement {
  if (budget.count >= MAX_SNAPSHOT_ELEMENTS) {
    return {
      ref: elementRef(element),
      role: roleFor(element),
      name: accessibleName(element),
      visible: true,
    };
  }
  budget.count += 1;
  const result: SnapshotElement = {
    ref: elementRef(element), role: roleFor(element), name: accessibleName(element), visible: true,
    ...(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? { value: bound(element.value) } : {}),
    ...(element.children.length === 0 && element.textContent?.trim() ? { text: bound(element.textContent.trim(), 8_192) } : {}),
    bounds: boundsOf(element),
    ...(isDisabled(element) ? { disabled: true } : {}),
    ...(element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio") ? { checked: element.checked } : {}),
    ...(element.getAttribute("aria-expanded") !== null ? { expanded: element.getAttribute("aria-expanded") === "true" } : {}),
  };
  if (depth >= MAX_DEPTH || budget.count >= MAX_SNAPSHOT_ELEMENTS) return result;
  const children: SnapshotElement[] = [];
  for (const child of Array.from(element.children).slice(0, MAX_SNAPSHOT_ELEMENTS)) {
    if (budget.count >= MAX_SNAPSHOT_ELEMENTS) break;
    if (!isVisible(child)) continue;
    children.push(snapshotNode(child, depth + 1, budget));
  }
  return children.length ? { ...result, children } : result;
}
function snapshot(): JsonValue {
  const doc = documentRoot();
  const body = doc.body ?? rootElement();
  const flat: SnapshotElement[] = [];
  const visit = (element: Element): void => {
    if (flat.length >= MAX_SNAPSHOT_ELEMENTS) return;
    if (isVisible(element)) flat.push(snapshotNode(element, MAX_DEPTH, { count: 0 }));
    for (const child of Array.from(element.children)) visit(child);
  };
  visit(body);
  const tree = isVisible(body) ? snapshotNode(body, 0, { count: 0 }) : null;
  return json({
    url: bound(doc.URL), title: bound(doc.title), readyState: doc.readyState,
    viewport: { x: 0, y: 0, width: Math.max(0, window.innerWidth), height: Math.max(0, window.innerHeight) },
    tree, elements: flat, capturedAt: Date.now(), truncated: flat.length >= MAX_SNAPSHOT_ELEMENTS,
  });
}
function postAction(params: Record<string, unknown>): Record<string, JsonValue> {
  return params.snapshotAfter === true ? { postActionSnapshot: snapshot() } : {};
}
function dispatchInput(element: Element): void {
  element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}
function focus(element: Element): void {
  if (typeof (element as HTMLElement).focus !== "function") throw new BrowserDomAutomationError("not_supported", "Element cannot receive focus");
  (element as HTMLElement).focus();
}
function setText(element: Element, value: string): void {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, "value")?.set;
    if (setter) setter.call(element, value); else element.value = value;
    dispatchInput(element); return;
  }
  if (element instanceof HTMLElement && element.isContentEditable) { element.textContent = value; dispatchInput(element); return; }
  throw new BrowserDomAutomationError("not_supported", "Element is not editable");
}
function keyEvent(type: "keydown" | "keyup", key: string, params: Record<string, unknown>): boolean {
  const modifiers = Array.isArray(params.modifiers) ? params.modifiers : [];
  const event = new KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true, composed: true, altKey: modifiers.includes("Alt"), ctrlKey: modifiers.includes("Control"), metaKey: modifiers.includes("Meta"), shiftKey: modifiers.includes("Shift") });
  return documentRoot().activeElement?.dispatchEvent(event) ?? false;
}
function json(value: unknown, depth = 0, seen = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return bound(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "undefined") return null;
  if (typeof value !== "object") return bound(String(value));
  if (depth >= 8 || seen.has(value)) return "[unavailable]";
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.slice(0, MAX_ELEMENTS).map((item) => json(item, depth + 1, seen));
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as object).slice(0, 128)) out[bound(key, 256)] = json((value as Record<string, unknown>)[key], depth + 1, seen);
    return out;
  } finally { seen.delete(value); }
}
function timeout(params: Record<string, unknown>): number { return Math.max(0, Math.min(MAX_TIMEOUT_MS, typeof params.timeoutMs === "number" ? params.timeoutMs : 5_000)); }
async function waitFor(params: Record<string, unknown>): Promise<JsonValue> {
  const kind = typeof params.kind === "string" ? params.kind : params.type;
  const expected = typeof params.value === "string" ? params.value : params.selector;
  const deadline = Date.now() + timeout(params);
  const check = (): boolean => {
    if (kind === "load") return documentRoot().readyState === "complete";
    if (kind === "url") return typeof expected === "string" && documentRoot().URL.includes(expected);
    if (kind === "text") return typeof expected === "string" && (documentRoot().body?.innerText ?? "").includes(expected);
    if (kind === "function") throw new BrowserDomAutomationError("not_supported", "Function waits must run through native browser automation");
    if (typeof expected === "string") return documentRoot().querySelector(expected) !== null;
    return false;
  };
  while (Date.now() <= deadline) {
    if (check()) return { matched: true };
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new BrowserDomAutomationError("timeout", "Wait timed out");
}
function findBy(kind: string, value: string): Element[] {
  const needle = value.toLocaleLowerCase();
  const candidates = Array.from(documentRoot().querySelectorAll("*"));
  return candidates.filter((element) => {
    if (kind === "role") return roleFor(element).toLocaleLowerCase() === needle;
    if (kind === "text") return (element.textContent ?? "").toLocaleLowerCase().includes(needle);
    if (kind === "label") return accessibleName(element).toLocaleLowerCase().includes(needle);
    if (kind === "placeholder") return (element.getAttribute("placeholder") ?? "").toLocaleLowerCase().includes(needle);
    if (kind === "alt") return (element.getAttribute("alt") ?? "").toLocaleLowerCase().includes(needle);
    if (kind === "title") return (element.getAttribute("title") ?? "").toLocaleLowerCase().includes(needle);
    if (kind === "testid") return (element.getAttribute("data-testid") ?? "").toLocaleLowerCase() === needle;
    return false;
  }).slice(0, MAX_ELEMENTS);
}
function resultElements(found: Element[]): JsonValue { return json({ elements: found.slice(0, MAX_ELEMENTS).map((element) => ({ ref: elementRef(element), role: roleFor(element), name: accessibleName(element), ...(isVisible(element) ? { bounds: boundsOf(element) } : {}) })) }); }
function styleResult(element: Element): JsonValue {
  const style = (element.ownerDocument.defaultView ?? window).getComputedStyle(element);
  const keys = ["display", "visibility", "opacity", "color", "backgroundColor", "fontSize", "fontFamily", "position", "width", "height"];
  const output: Record<string, JsonValue> = {}; for (const key of keys) output[key] = bound(style.getPropertyValue(key), 512); return output;
}
function installDialogs(): void {
  if (dialogInstalled || typeof window === "undefined") return;
  dialogInstalled = true;
  const original = { alert: window.alert, confirm: window.confirm, prompt: window.prompt };
  window.alert = (message?: unknown) => { dialogQueue.push({ type: "alert", message: bound(String(message ?? "")) }); };
  window.confirm = (message?: unknown) => { dialogQueue.push({ type: "confirm", message: bound(String(message ?? "")) }); return false; };
  window.prompt = (message?: unknown, defaultValue?: string) => { dialogQueue.push({ type: "prompt", message: bound(String(message ?? "")), defaultValue: bound(defaultValue ?? "") }); return null; };
  void original;
}
function designModeStatus(): JsonValue { return { enabled: designModeDocuments.size > 0, selection: bound(window.getSelection()?.toString() ?? "", 4_000) }; }
function setDesignMode(params: Record<string, unknown>): JsonValue {
  const root = documentRoot();
  const enabled = params.enabled === true;
  if (enabled) {
    if (!designModeOriginals.has(root)) {
      designModeOriginals.set(root, root.designMode);
      designModeDocuments.add(root);
    }
    root.designMode = "on";
  } else {
    for (const document of designModeDocuments) {
      const original = designModeOriginals.get(document);
      if (original !== undefined) document.designMode = original;
    }
    designModeDocuments.clear();
    designModeOriginals = new WeakMap<Document, string>();
  }
  return designModeStatus();
}
function storage(area: "local" | "session"): Storage { try { return area === "local" ? window.localStorage : window.sessionStorage; } catch { throw new BrowserDomAutomationError("security", "Storage is unavailable"); } }

export function resetBrowserDomAutomation(): void {
  for (const root of designModeDocuments) {
    const original = designModeOriginals.get(root);
    if (original !== undefined) root.designMode = original;
  }
  designModeDocuments.clear();
  refs.clear(); nextRef = 1; activeDocument = null;
  designModeOriginals = new WeakMap<Document, string>(); savedState = null; dialogQueue.length = 0;
}

export async function executeBrowserDomAutomation(method: string, rawParams: Record<string, unknown>): Promise<unknown> {
  installDialogs();
  const params = record(rawParams);
  const name = method.replace(/^browser\./u, "").replaceAll("-", "_");
  if (name === "snapshot") return { snapshot: snapshot() };
  if (name === "eval") throw new BrowserDomAutomationError("not_supported", "Evaluation must run through native browser automation");
  if (name === "wait") return waitFor(params);
  if (name === "design_mode.status") return designModeStatus();
  if (name === "design_mode.set") return setDesignMode(params);
  if (name === "frame.main") { activeDocument = null; refs.clear(); return { ok: true }; }
  if (name === "frame.select") {
    const frame = target(params, true);
    if (!(frame instanceof HTMLIFrameElement || frame instanceof HTMLFrameElement)) throw new BrowserDomAutomationError("not_found", "Frame was not found");
    try { if (!frame.contentDocument) throw new Error(); activeDocument = frame.contentDocument; refs.clear(); return { ok: true, url: bound(activeDocument.URL) }; } catch { throw new BrowserDomAutomationError("security", "Frame is not same-origin"); }
  }
  if (name === "state.save") { savedState = json({ url: documentRoot().URL, scrollX: window.scrollX, scrollY: window.scrollY, values: Array.from(documentRoot().querySelectorAll("input,textarea,select")).slice(0, MAX_ELEMENTS).map((element) => ({ id: element.id, value: (element as HTMLInputElement).value })) }); return { saved: true }; }
  if (name === "state.load") { if (savedState && typeof savedState === "object" && !Array.isArray(savedState)) { const values = (savedState as Record<string, JsonValue>).values; if (Array.isArray(values)) for (const value of values) if (value && typeof value === "object" && !Array.isArray(value) && typeof value.id === "string" && typeof value.value === "string") { const element = documentRoot().getElementById(value.id); if (element) setText(element, value.value); } } return { loaded: savedState !== null }; }
  if (name === "addinitscript" || name === "addscript") throw new BrowserDomAutomationError("not_supported", "Scripts must run through native browser automation");
  if (name === "addstyle") { const source = text(params.style ?? params.css, "style", MAX_SCRIPT_BYTES); const style = documentRoot().createElement("style"); style.textContent = source; (documentRoot().head ?? documentRoot().documentElement).append(style); return { added: true }; }
  if (name === "dialog.accept" || name === "dialog.dismiss") { const dialog = dialogQueue.shift(); if (!dialog) throw new BrowserDomAutomationError("not_found", "No queued dialog"); return { type: dialog.type, message: dialog.message, accepted: name.endsWith("accept"), ...(dialog.type === "prompt" ? { value: name.endsWith("accept") ? dialog.defaultValue ?? "" : null } : {}) }; }
  if (name === "highlight") { const element = target(params); if (!element) throw new BrowserDomAutomationError("not_found", "Element was not found"); element.scrollIntoView({ block: "center", inline: "nearest" }); element.setAttribute("data-t4-highlight", "true"); return { highlighted: true, ref: elementRef(element) }; }
  if (name.startsWith("find.")) { const kind = name.slice(5); if (["first", "last", "nth"].includes(kind)) { const list = params.selector ? all(text(params.selector, "selector", 4_096)) : [target(params) as Element]; const index = kind === "first" ? 0 : kind === "last" ? list.length - 1 : Math.max(0, Math.min(list.length - 1, Number(params.index ?? params.n ?? 0))); if (!list[index]) throw new BrowserDomAutomationError("not_found", "Element was not found"); return resultElements([list[index]]); } return resultElements(findBy(kind, text(params.query ?? params.text ?? params.value ?? params.role ?? params.label ?? params.placeholder ?? params.testid ?? params.alt ?? params.title, "query", 8_192))); }
  if (name === "get.title") return { title: bound(documentRoot().title), url: bound(documentRoot().URL) };
  if (name === "get.count") { const selector = text(params.selector, "selector", 4_096); return { count: all(selector).length }; }
  const element = target(params, !["press", "keydown", "keyup", "scroll", "storage.get", "storage.set", "storage.clear"].includes(name));
  if (name === "get.text") return { text: bound(element?.textContent?.trim() ?? "", 32_768) };
  if (name === "get.html") return { html: bound(element?.outerHTML ?? documentRoot().documentElement.outerHTML) };
  if (name === "get.value") return { value: bound(element && "value" in element ? String((element as HTMLInputElement).value) : "", 32_768) };
  if (name === "get.attr") { const attr = text(params.name ?? params.attr, "name", 256); return { value: element?.getAttribute(attr) === null ? null : bound(element?.getAttribute(attr) ?? "") }; }
  if (name === "get.box") return { box: element ? boundsOf(element) : boundsOf(rootElement()) };
  if (name === "get.styles") return styleResult(element ?? rootElement());
  if (name === "is.visible") return { value: element ? isVisible(element) : false };
  if (name === "is.enabled") return { value: element ? !isDisabled(element) : false };
  if (name === "is.checked") return { value: element instanceof HTMLInputElement ? element.checked : element?.getAttribute("aria-checked") === "true" };
  if (name === "click" || name === "dblclick") { if (!element) throw new BrowserDomAutomationError("not_found", "Element was not found"); if (isDisabled(element)) throw new BrowserDomAutomationError("invalid_state", "Element is disabled"); focus(element); element.dispatchEvent(new MouseEvent(name === "click" ? "click" : "dblclick", { bubbles: true, cancelable: true, view: window, detail: name === "click" ? Math.max(1, Number(params.clickCount ?? 1)) : 2 })); return { ok: true, ...postAction(params) }; }
  if (name === "hover") { if (!element) throw new BrowserDomAutomationError("not_found", "Element was not found"); element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, view: window })); element.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, view: window })); return { ok: true, ...postAction(params) }; }
  if (name === "focus") { if (!element) throw new BrowserDomAutomationError("not_found", "Element was not found"); focus(element); return { ok: true, ...postAction(params) }; }
  if (name === "fill") { if (!element) throw new BrowserDomAutomationError("not_found", "Element was not found"); setText(element, text(params.value, "value", 16_384)); return { ok: true, ...postAction(params) }; }
  if (name === "type") { if (!element) throw new BrowserDomAutomationError("not_found", "Element was not found"); focus(element); const value = text(params.text, "text", 16_384); for (const character of value) { setText(element, `${element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element.textContent ?? ""}${character}`); if (typeof params.intervalMs === "number" && params.intervalMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, Math.min(10_000, params.intervalMs as number))); } return { ok: true, ...postAction(params) }; }
  if (name === "press" || name === "keydown" || name === "keyup") { const key = text(params.key, "key", 128); if (name === "press") { keyEvent("keydown", key, params); keyEvent("keyup", key, params); } else keyEvent(name, key, params); return { ok: true, ...postAction(params) }; }
  if (name === "check" || name === "uncheck") { if (!(element instanceof HTMLInputElement) || (element.type !== "checkbox" && element.type !== "radio")) throw new BrowserDomAutomationError("not_supported", "Element is not a checkbox"); element.checked = name === "check"; dispatchInput(element); return { ok: true, ...postAction(params) }; }
  if (name === "select") { if (!(element instanceof HTMLSelectElement)) throw new BrowserDomAutomationError("not_supported", "Element is not a select"); const values = Array.isArray(params.values) ? params.values.filter((value): value is string => typeof value === "string").slice(0, 64) : [text(params.value, "value", 1_024)]; for (const option of Array.from(element.options)) option.selected = values.includes(option.value) || values.includes(option.text); dispatchInput(element); return { ok: true, ...postAction(params) }; }
  if (name === "scroll" || name === "scroll_into_view") { if (name === "scroll_into_view" && element) element.scrollIntoView({ block: "center", inline: "nearest" }); else if (element) (element as HTMLElement).scrollBy(finiteNumber(params.x), finiteNumber(params.y)); else window.scrollBy(finiteNumber(params.x), finiteNumber(params.y)); return { ok: true, ...postAction(params) }; }
  if (name === "storage.get" || name === "storage.set" || name === "storage.clear") { const area = params.storageArea === "session" ? "session" : "local"; const store = storage(area); if (name === "storage.clear") { store.clear(); return { entries: {} }; } if (name === "storage.set") { const key = text(params.key, "key", 2_048); const value = text(params.value, "value", 16_384); store.setItem(key, value); return { entries: { [key]: value } }; } const entries: Record<string, string> = {}; const key = params.key === undefined ? undefined : text(params.key, "key", 2_048); if (key !== undefined) { const value = store.getItem(key); if (value !== null) entries[key] = bound(value, 16_384); } else for (let index = 0; index < Math.min(store.length, MAX_ELEMENTS); index += 1) { const itemKey = store.key(index); if (itemKey) entries[bound(itemKey, 2_048)] = bound(store.getItem(itemKey) ?? "", 16_384); } return { entries }; }
  throw new BrowserDomAutomationError("not_supported", `Unsupported browser DOM method: ${bound(method, 128)}`);
}
