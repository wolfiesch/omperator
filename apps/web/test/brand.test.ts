// Product-name guard: every human-visible surface says "T4 Code"; the
// retired name never comes back, and runtime references ("T4 host",
// "Oh My Pi") stay untouched.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const WEB_ROOT = join(import.meta.dirname, "..");
const SRC_ROOT = join(WEB_ROOT, "src");

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...listSourceFiles(path));
    } else if (/\.(ts|tsx|css|html)$/.test(entry)) {
      files.push(path);
    }
  }
  return files;
}

describe("product identity", () => {
  it("titles the document T4 Code", () => {
    const html = readFileSync(join(WEB_ROOT, "index.html"), "utf8");
    expect(html).toContain("<title>T4 Code</title>");
  });

  it("never says the retired product name anywhere in web source", () => {
    for (const file of [join(WEB_ROOT, "index.html"), ...listSourceFiles(SRC_ROOT)]) {
      const content = readFileSync(file, "utf8");
      expect(content.includes("Command Center"), `${file} says "Command Center"`).toBe(false);
    }
  });

  it("never shows retired identifiers: command-center, the @omp scope, or the retired legacy accent", () => {
    for (const file of [join(WEB_ROOT, "index.html"), ...listSourceFiles(SRC_ROOT)]) {
      const content = readFileSync(file, "utf8");
      expect(content.includes("command-center"), `${file} says "command-center"`).toBe(false);
      expect(content.includes("@omp/"), `${file} references the retired @omp scope`).toBe(false);
      expect(/f97316/i.test(content), `${file} carries the retired legacy accent`).toBe(false);
    }
  });

  it("keeps the runtime named OMP in onboarding copy", () => {
    const flow = readFileSync(join(SRC_ROOT, "features/onboarding/flow.ts"), "utf8");
    expect(flow).toContain("local T4 host backed by OMP");
  });

  it("names the product and its runtime in the onboarding header", () => {
    const onboarding = readFileSync(
      join(SRC_ROOT, "features/onboarding/OnboardingFlow.tsx"),
      "utf8",
    );
    expect(onboarding).toContain("Set up T4 Code");
    expect(onboarding).toContain("Powered by Oh My Pi");
  });
});
