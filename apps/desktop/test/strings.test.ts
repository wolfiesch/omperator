// Native-shell identity: the product is T4 Code everywhere the OS shows a
// string, and the app-server/runtime keeps its own name.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { APP_NAME, strings } from "../src/strings.ts";

describe("native shell strings", () => {
  it("names the product T4 Code", () => {
    expect(APP_NAME).toBe("T4 Code");
    expect(strings.window.title).toBe("T4 Code");
    expect(strings.menu.app.about).toBe("About T4 Code");
    expect(strings.accessibility.mainWindow).toBe("T4 Code main window");
  });

  it("never says the retired product name", () => {
    expect(JSON.stringify(strings).includes("Command Center")).toBe(false);
  });

  it("ships productName T4 Code", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8"));
    expect(pkg.productName).toBe("T4 Code");
  });
});
