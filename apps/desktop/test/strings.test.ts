// Native-shell identity: the product is Omperator everywhere the OS shows a
// string, and the app-server/runtime keeps its own name.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { APP_NAME, strings } from "../src/strings.ts";

describe("native shell strings", () => {
  it("names the product Omperator", () => {
    expect(APP_NAME).toBe("Omperator");
    expect(strings.window.title).toBe("Omperator");
    expect(strings.menu.app.about).toBe("About Omperator");
    expect(strings.accessibility.mainWindow).toBe("Omperator main window");
  });

  it("never says the retired product name", () => {
    expect(JSON.stringify(strings).includes("Command Center")).toBe(false);
  });

  it("ships productName Omperator", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8"));
    expect(pkg.productName).toBe("Omperator");
  });
});
