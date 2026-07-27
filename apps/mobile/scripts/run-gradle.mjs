import { spawn, spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { delimiter, resolve } from "node:path";

const mobileRoot = resolve(import.meta.dirname, "..");
const gradlew = resolve(mobileRoot, "android/gradlew");
const sdkRoot = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? resolve(process.env.HOME ?? "", "Android/sdk");
// The fallback is the CI runner's layout. On macOS that path cannot exist, so
// resolve through java_home there instead of failing with a Linux path the
// developer never configured.
function fallbackJavaHome() {
  if (process.platform !== "darwin") return "/usr/lib/jvm/java-21-openjdk-amd64";
  const located = spawnSync("/usr/libexec/java_home", ["-v", "21"], { encoding: "utf8" });
  if (located.status === 0) return located.stdout.trim();
  throw new Error("set JAVA_HOME, or install a JDK 21 that /usr/libexec/java_home can find");
}
const javaHome = process.env.JAVA_HOME ?? fallbackJavaHome();

await access(gradlew);
await access(resolve(javaHome, "bin/java"));

const tasks = process.argv.slice(2);
if (tasks.length === 0) throw new Error("pass at least one Gradle task");

const child = spawn(gradlew, ["--no-daemon", ...tasks], {
  cwd: resolve(mobileRoot, "android"),
  env: {
    ...process.env,
    ANDROID_HOME: sdkRoot,
    ANDROID_SDK_ROOT: sdkRoot,
    JAVA_HOME: javaHome,
    PATH: `${resolve(javaHome, "bin")}${delimiter}${resolve(sdkRoot, "platform-tools")}${delimiter}${process.env.PATH ?? ""}`,
  },
  stdio: "inherit",
});

child.on("error", (error) => {
  throw error;
});

const exitCode = await new Promise((resolveExit) => {
  child.on("exit", (code, signal) => {
    if (signal !== null) throw new Error(`Gradle terminated by ${signal}`);
    resolveExit(code ?? 1);
  });
});

process.exitCode = exitCode;
