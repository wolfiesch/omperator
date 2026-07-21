import { describe, expect, it } from "vitest";

import {
  executeBrowserDomAutomation,
  resetBrowserDomAutomation,
} from "../src/browser-dom-automation.ts";

const DOM_GLOBALS = [
  "document",
  "window",
  "Element",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLFrameElement",
  "HTMLIFrameElement",
  "HTMLImageElement",
  "HTMLInputElement",
  "HTMLSelectElement",
  "HTMLTextAreaElement",
] as const;
const originalGlobals = new Map(
  DOM_GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
);

function exposeGlobal(name: (typeof DOM_GLOBALS)[number], value: unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
}

function restoreGlobals(): void {
  resetBrowserDomAutomation();
  for (const name of DOM_GLOBALS) {
    const descriptor = originalGlobals.get(name);
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
}

interface FakeStyle {
  readonly display: string;
  readonly visibility: string;
  readonly opacity: string;
}

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly isConnected = true;
  readonly ownerDocument: FakeDocument;
  readonly style: FakeStyle;
  readonly tagName: string;
  parentElement: FakeElement | null = null;
  textContent: string;

  constructor(
    tagName: string,
    ownerDocument: FakeDocument,
    textContent = "",
    style: FakeStyle = { display: "block", visibility: "visible", opacity: "1" },
  ) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.textContent = textContent;
    this.style = style;
  }

  append(child: FakeElement): void {
    child.parentElement = this;
    this.children.push(child);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  closest(): null {
    return null;
  }

  getBoundingClientRect(): { x: number; y: number; width: number; height: number } {
    return { x: 0, y: 0, width: 640, height: 24 };
  }
}

class FakeHTMLElement extends FakeElement {}
class FakeHTMLButtonElement extends FakeHTMLElement {}
class FakeHTMLFrameElement extends FakeHTMLElement { readonly contentDocument = null; }
class FakeHTMLIFrameElement extends FakeHTMLElement { readonly contentDocument = null; }
class FakeHTMLImageElement extends FakeHTMLElement { readonly alt = ""; }
class FakeHTMLInputElement extends FakeHTMLElement {
  readonly checked = false;
  readonly disabled = false;
  readonly id = "";
  readonly type = "text";
  readonly value: string;
  constructor(tagName: string, ownerDocument: FakeDocument, value: string) {
    super(tagName, ownerDocument);
    this.value = value;
  }
}
class FakeHTMLSelectElement extends FakeHTMLElement { readonly disabled = false; readonly value = ""; }
class FakeHTMLTextAreaElement extends FakeHTMLElement { readonly disabled = false; readonly value = ""; }

class FakeDocument {
  readonly URL = "https://example.test/dashboard";
  readonly defaultView: FakeWindow;
  readonly readyState = "complete";
  readonly title = "Dashboard";
  body!: FakeHTMLElement;

  constructor() {
    this.defaultView = new FakeWindow();
  }
}

class FakeWindow {
  alert = () => undefined;
  confirm = () => false;
  prompt = () => null;
  readonly innerHeight = 720;
  readonly innerWidth = 1_280;
  getComputedStyle(element: FakeElement): FakeStyle { return element.style; }
  getSelection(): null { return null; }
}

function exposeSnapshotDom(document: FakeDocument): void {
  exposeGlobal("document", document);
  exposeGlobal("window", document.defaultView);
  exposeGlobal("Element", FakeElement);
  exposeGlobal("HTMLElement", FakeHTMLElement);
  exposeGlobal("HTMLButtonElement", FakeHTMLButtonElement);
  exposeGlobal("HTMLFrameElement", FakeHTMLFrameElement);
  exposeGlobal("HTMLIFrameElement", FakeHTMLIFrameElement);
  exposeGlobal("HTMLImageElement", FakeHTMLImageElement);
  exposeGlobal("HTMLInputElement", FakeHTMLInputElement);
  exposeGlobal("HTMLSelectElement", FakeHTMLSelectElement);
  exposeGlobal("HTMLTextAreaElement", FakeHTMLTextAreaElement);
}

describe("browser DOM Design Mode", () => {
  it("restores every document exactly and reports only T4-owned edit state", async () => {
    const pageWindow = {
      alert: () => undefined,
      confirm: () => false,
      prompt: () => null,
      getSelection: () => null,
    };
    const mainDocument = { designMode: "off" };
    const frameDocument = { designMode: "on" };
    try {
      exposeGlobal("window", pageWindow);

      exposeGlobal("document", mainDocument);
      expect(
        await executeBrowserDomAutomation("browser.design_mode.set", { enabled: true }),
      ).toEqual({ enabled: true, selection: "" });
      expect(mainDocument.designMode).toBe("on");

      exposeGlobal("document", frameDocument);
      expect(
        await executeBrowserDomAutomation("browser.design_mode.set", { enabled: true }),
      ).toEqual({ enabled: true, selection: "" });

      expect(
        await executeBrowserDomAutomation("browser.design_mode.set", { enabled: false }),
      ).toEqual({ enabled: false, selection: "" });
      expect(mainDocument.designMode).toBe("off");
      expect(frameDocument.designMode).toBe("on");
    } finally {
      restoreGlobals();
    }
  });
});

describe("browser DOM accessibility snapshot", () => {
  it("keeps visible content, excludes hidden DOM, and avoids container text duplication", async () => {
    const document = new FakeDocument();
    const body = new FakeHTMLElement("BODY", document, "Visible account Hidden secret Password");
    const main = new FakeHTMLElement("MAIN", document, "Visible account Hidden secret Password");
    const heading = new FakeHTMLElement("H1", document, "Visible account");
    const hidden = new FakeHTMLElement("DIV", document, "Hidden secret", {
      display: "none",
      visibility: "visible",
      opacity: "1",
    });
    const input = new FakeHTMLInputElement("INPUT", document, "never-stage-this");
    input.attributes.set("placeholder", "Password");
    body.append(main);
    main.append(heading);
    main.append(hidden);
    main.append(input);
    document.body = body;

    try {
      exposeSnapshotDom(document);
      const result = await executeBrowserDomAutomation("browser.snapshot", {});
      const snapshot = (result as { readonly snapshot: { readonly elements: readonly Record<string, unknown>[] } }).snapshot;

      expect(
        snapshot.elements.some(
          (element) =>
            element.role === "heading" &&
            element.name === "Visible account" &&
            element.visible === true,
        ),
      ).toBe(true);
      expect(
        snapshot.elements.some(
          (element) =>
            element.role === "textbox" &&
            element.name === "Password" &&
            element.value === "never-stage-this" &&
            element.visible === true,
        ),
      ).toBe(true);
      expect(snapshot.elements.some((element) => element.name === "Hidden secret")).toBe(false);
      expect(
        snapshot.elements.some(
          (element) =>
            (element.role === "document" || element.role === "main") &&
            typeof element.name === "string" &&
            element.name.includes("Visible account"),
        ),
      ).toBe(false);
    } finally {
      restoreGlobals();
    }
  });
});
