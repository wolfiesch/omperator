import { useEffect, useState } from "react";
import { renderInline } from "../inline.tsx";
import {
  assetsFor,
  detectPlatform,
  OMP_URL,
  primaryAsset,
  RELEASE_ASSETS,
  RELEASE_VERSION,
  RELEASES_URL,
  REPO_URL,
  type DesktopPlatform,
} from "../release.ts";

interface Feature {
  readonly title: string;
  readonly body: string;
}

// Every claim traces to shipped code; see the docs page for the details.
const FEATURES: readonly Feature[] = [
  {
    title: "Sessions keep their place",
    body: "Up to 8 recent sessions stay warm in the background. Live output keeps applying while you are elsewhere, so switching back is instant, with drafts, scroll, and panels intact.",
  },
  {
    title: "Agents stay legible",
    body: "When a session fans work out to agents, the agents pane shows each one as it runs. Cancel one when you need to; the host confirms every action.",
  },
  {
    title: "Terminals, files, review",
    body: "Attach to real terminals on the host, browse project files, and apply reviewed diffs. No terminal scraping; everything goes through the host's protocol.",
  },
  {
    title: "Remote hosts, paired once",
    body: "Pair with an Oh My Pi host on another machine using a one-time link. Credentials are encrypted with OS secure storage, and drops reconnect on their own.",
  },
  {
    title: "Model, thinking, fast",
    body: "Change a running session's model, thinking effort, or fast mode from the composer. If the host declines, the session keeps its value and the app says so.",
  },
  {
    title: "OMP owns the truth",
    body: "Oh My Pi is the runtime and settings authority. T4 Code renders what the host reports and marks unconfirmed state as unconfirmed. It never guesses.",
  },
];

function DownloadButtons({ platform }: { platform: DesktopPlatform }) {
  const android = primaryAsset("android");
  const main = primaryAsset(platform);
  const other: DesktopPlatform = platform === "linux" ? "mac" : "linux";
  const otherMain = primaryAsset(other);
  return (
    <div className="hero-actions">
      <a className="btn btn-primary" href={android.url}>
        Download Android APK
      </a>
      <a className="btn btn-outline" href={main.url}>
        Download for {platform === "linux" ? "Linux" : "macOS"}
      </a>
      <a className="btn btn-outline" href={otherMain.url}>
        {other === "linux" ? "Linux" : "macOS"} build
      </a>
      <a className="btn btn-outline" href={REPO_URL} rel="noopener">
        View source
      </a>
    </div>
  );
}

export function Landing() {
  // Render Linux first (matches the build host + crawler default), then
  // correct for macOS visitors after mount. Both buttons are always visible.
  const [platform, setPlatform] = useState<DesktopPlatform>("linux");
  useEffect(() => {
    setPlatform(detectPlatform(navigator.userAgent));
  }, []);

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="container topbar-inner">
          <a className="wordmark" href="/">
            <img src="/omp-mark.svg" alt="" width="26" height="20" />
            T4 Code
          </a>
          <nav className="topbar-nav" aria-label="Site">
            <a href="/docs/">Docs</a>
            <a href={REPO_URL} rel="noopener" className="hide-narrow">
              GitHub
            </a>
            <a className="btn btn-primary btn-small" href="#download">
              Download
            </a>
          </nav>
        </div>
      </header>

      <main id="main">
        <section className="hero container">
          <p className="runtime-line">
            <span className="dot" aria-hidden="true" />
            Free and open source · MIT · Powered by Oh My Pi
          </p>
          <h1>The open-source client for Oh My Pi</h1>
          <p className="sub">
            T4 Code puts your OMP sessions, agents, terminals, files, and reviews in one place, from
            your workstation or Android phone. Built for people who live in OMP all day.
          </p>
          <DownloadButtons platform={platform} />
          <p className="hero-fineprint">
            v{RELEASE_VERSION} · Android APK · Linux x86_64 · macOS Apple Silicon · iOS TestFlight
            coming soon ·{" "}
            <a href={RELEASES_URL} rel="noopener">
              all downloads
            </a>
          </p>
          <figure className="shot">
            <img
              src="/screenshots/t4-code-main.png"
              alt="T4 Code main window: session rail on the left, a streaming session transcript in the center, and the composer at the bottom."
              width="1600"
              height="1000"
            />
            <figcaption>A live session streaming in T4 Code.</figcaption>
          </figure>
        </section>

        <section className="section" aria-labelledby="features-title">
          <div className="container">
            <h2 id="features-title">What it does</h2>
            <p className="section-lede">
              A desktop control surface and Android thin client for the OMP runtime. There is no
              cloud service and no account. T4 Code talks straight to your host over its typed
              protocol.
            </p>
            <div className="feature-grid">
              {FEATURES.map((feature) => (
                <div className="feature" key={feature.title}>
                  <h3>{feature.title}</h3>
                  <p>{feature.body}</p>
                </div>
              ))}
            </div>
            <div className="feature-pair">
              <figure className="shot">
                <img
                  src="/screenshots/t4-code-agents.png"
                  alt="The agents pane listing running subagents next to the session transcript."
                  width="1600"
                  height="1000"
                  loading="lazy"
                />
                <figcaption>Agents, as the host reports them.</figcaption>
              </figure>
              <figure className="shot">
                <img
                  src="/screenshots/t4-code-settings.png"
                  alt="The settings screen with model roles mapped to models from the host's catalog."
                  width="1600"
                  height="1000"
                  loading="lazy"
                />
                <figcaption>Model roles, staged locally, confirmed by the host.</figcaption>
              </figure>
            </div>
          </div>
        </section>

        <section className="section" aria-labelledby="install-title">
          <div className="container">
            <h2 id="install-title">Install</h2>
            <p className="section-lede">
              {renderInline(
                `T4 Code needs an [Oh My Pi](${OMP_URL}) build with desktop appserver support on the machine that runs your sessions. The [docs](/docs/) cover first run, pairing, and troubleshooting.`,
              )}
            </p>
            <div className="mobile-install-grid">
              <div className="mobile-install-card android-install-card">
                <p className="platform-label">Available now</p>
                <h3>Android APK</h3>
                <p>
                  Install T4 Code directly on your phone, then connect to the OMP host you already
                  run.
                </p>
                <a className="btn btn-primary" href={primaryAsset("android").url}>
                  Download Android APK
                </a>
              </div>
              <div className="mobile-install-card ios-install-card">
                <p className="platform-label">iPhone &amp; iPad</p>
                <h3>TestFlight coming soon</h3>
                <p>The TestFlight link will appear here when the iOS build is ready.</p>
              </div>
            </div>
            <h3 className="desktop-install-title">Desktop builds</h3>
            <div className="install-grid">
              <div className="install-card">
                <h3>Linux</h3>
                <p className="arch">x86_64 · .deb or AppImage</p>
                <pre className="code">
                  <code>sudo apt install ./{assetsFor("linux")[0]!.filename}</code>
                </pre>
                <p>
                  {renderInline(
                    "`apt install` pulls in system dependencies. Prefer the AppImage on non-Debian distributions.",
                  )}
                </p>
              </div>
              <div className="install-card">
                <h3>macOS</h3>
                <p className="arch">Apple Silicon · .dmg or .zip</p>
                <pre className="code">
                  <code>xattr -dr com.apple.quarantine "/Applications/T4 Code.app"</code>
                </pre>
                <p>
                  Drag the app to Applications first. The command clears Gatekeeper's quarantine
                  flag; right-click → Open works too.
                </p>
              </div>
            </div>
            <div className="notice notice-spaced" role="note">
              <strong>Heads up:</strong> the v{RELEASE_VERSION} macOS build is unsigned and not
              notarized, so macOS warns before first launch. If you would rather not run an unsigned
              binary, {renderInline(`[build it from source](/docs/#build-from-source)`)}. The whole
              app is public.
            </div>
          </div>
        </section>

        <section className="band" id="download" aria-labelledby="download-title">
          <div className="container">
            <h2 id="download-title">Get T4 Code</h2>
            <p>Android and desktop builds are ready now. iOS TestFlight is coming soon.</p>
            <DownloadButtons platform={platform} />
            <ul className="asset-list">
              {RELEASE_ASSETS.map((asset) => (
                <li key={asset.filename}>
                  <a href={asset.url}>{asset.filename}</a>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="container footer-inner">
          <span>MIT License · © 2026 Lycaon Solutions</span>
          <nav className="footer-links" aria-label="Footer">
            <a href="/docs/">Docs</a>
            <a href={REPO_URL} rel="noopener">
              Source on GitHub
            </a>
            <a href={RELEASES_URL} rel="noopener">
              Releases
            </a>
            <a href={OMP_URL} rel="noopener">
              Oh My Pi
            </a>
          </nav>
        </div>
      </footer>
    </>
  );
}
