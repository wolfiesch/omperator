import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { renderInline } from "../inline.tsx";
import { REPO_URL } from "../release.ts";
import {
  DEFAULT_TOPIC_ID,
  DOC_GROUPS,
  DOC_TOPICS,
  resolveTopicForHash,
  type Block,
  type DocTopic,
} from "./content.ts";
import { buildSearchIndex, plainText, search, type SearchEntry } from "./search.ts";

const SEARCH_INDEX = buildSearchIndex(DOC_TOPICS);

function topicFromLocation(): DocTopic {
  return (
    resolveTopicForHash(window.location.hash) ??
    DOC_TOPICS.find((t) => t.id === DEFAULT_TOPIC_ID) ??
    DOC_TOPICS[0]!
  );
}

/* ---------- Code block with copy button ---------- */

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="codeblock">
      <pre className="code" tabIndex={0}>
        <code>{code}</code>
      </pre>
      <button type="button" className="copy-btn" onClick={copy} aria-live="polite">
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/* ---------- Article block renderer ---------- */

function Heading({ level, id, text }: { level: 2 | 3; id: string; text: string }) {
  const Tag = level === 2 ? "h2" : "h3";
  return (
    <Tag id={id}>
      <a className="heading-anchor" href={`#${id}`}>
        {renderInline(text)}
        <span className="hash" aria-hidden="true">
          #
        </span>
      </a>
    </Tag>
  );
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case "p":
      return <p key={key}>{renderInline(block.text)}</p>;
    case "h2":
      return <Heading key={key} level={2} id={block.id} text={block.text} />;
    case "h3":
      return <Heading key={key} level={3} id={block.id} text={block.text} />;
    case "code":
      return <CodeBlock key={key} code={block.code} />;
    case "ul":
      return (
        <ul key={key}>
          {block.items.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol key={key}>
          {block.items.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ol>
      );
    case "note":
      return (
        <div key={key} className="notice" role="note">
          {renderInline(block.text)}
        </div>
      );
    case "table":
      return (
        <div className="table-scroll" key={key} tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th scope="col">{block.head[0]}</th>
                <th scope="col">{block.head[1]}</th>
              </tr>
            </thead>
            <tbody>
              {block.rows.map(([a, b], i) => (
                <tr key={i}>
                  <td>
                    <code>{a}</code>
                  </td>
                  <td>{renderInline(b)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/* ---------- Sidebar ---------- */

function SidebarNav({ activeId, onNavigate }: { activeId: string; onNavigate?: () => void }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  return (
    <nav aria-label="Documentation">
      {DOC_GROUPS.map((group) => {
        const isCollapsed = collapsed[group.title] === true;
        const listId = `group-${group.title.toLowerCase().replace(/\s+/g, "-")}`;
        return (
          <div className="sidebar-group" key={group.title}>
            <button
              type="button"
              aria-expanded={!isCollapsed}
              aria-controls={listId}
              onClick={() =>
                setCollapsed((prev) => ({ ...prev, [group.title]: !isCollapsed }))
              }
            >
              {group.title}
              <span className="chevron" aria-hidden="true">
                ▾
              </span>
            </button>
            {!isCollapsed && (
              <ul id={listId}>
                {group.topics.map((topic) => (
                  <li key={topic.id}>
                    <a
                      href={`#${topic.id}`}
                      aria-current={topic.id === activeId ? "page" : undefined}
                      onClick={onNavigate}
                    >
                      {topic.title}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}

/* ---------- Search dialog ---------- */

function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const results = useMemo(() => search(SEARCH_INDEX, query), [query]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setQuery("");
      setActive(0);
      dialog.showModal();
      inputRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const go = useCallback(
    (entry: SearchEntry) => {
      onClose();
      window.location.hash = `#${entry.anchor}`;
    },
    [onClose],
  );

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const hit = results[active] ?? results[0];
      if (hit) go(hit.entry);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="search-dialog"
      aria-label="Search documentation"
      onClose={onClose}
      onKeyDown={onKeyDown}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
    >
      <input
        ref={inputRef}
        type="search"
        placeholder="Search the docs…"
        aria-label="Search the docs"
        role="combobox"
        aria-expanded={results.length > 0}
        aria-controls="search-results"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
      />
      {query.trim().length > 0 && results.length === 0 ? (
        <p className="search-empty">Nothing found for “{query.trim()}”.</p>
      ) : (
        <ul className="search-results" id="search-results" role="listbox">
          {results.map((result, i) => (
            <li key={result.entry.anchor} role="option" aria-selected={i === active}>
              <a
                href={`#${result.entry.anchor}`}
                className={i === active ? "active" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  go(result.entry);
                }}
                onMouseEnter={() => setActive(i)}
              >
                {result.entry.title}
                {result.entry.title !== result.entry.topicTitle && (
                  <span className="result-topic">{result.entry.topicTitle}</span>
                )}
              </a>
            </li>
          ))}
        </ul>
      )}
    </dialog>
  );
}

/* ---------- Mobile drawer ---------- */

function Drawer({
  open,
  onClose,
  activeId,
}: {
  open: boolean;
  onClose: () => void;
  activeId: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={dialogRef}
      className="drawer"
      aria-label="Documentation menu"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
    >
      <div className="drawer-head">
        <strong>Docs</strong>
        <button type="button" className="btn btn-outline btn-small" onClick={onClose}>
          Close
        </button>
      </div>
      <SidebarNav activeId={activeId} onNavigate={onClose} />
    </dialog>
  );
}

/* ---------- App ---------- */

export function DocsApp() {
  const [topic, setTopic] = useState<DocTopic>(topicFromLocation);
  const [searchOpen, setSearchOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [currentHash, setCurrentHash] = useState(() => window.location.hash);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);

  // Hash routing: resolve the owning topic, render it, then scroll to the
  // anchored element once it exists.
  useEffect(() => {
    const apply = () => {
      const next = topicFromLocation();
      setTopic(next);
      setCurrentHash(window.location.hash);
      const id = window.location.hash.slice(1);
      if (id.length > 0) {
        requestAnimationFrame(() => {
          document.getElementById(decodeURIComponent(id))?.scrollIntoView();
        });
      } else {
        window.scrollTo(0, 0);
      }
    };
    window.addEventListener("hashchange", apply);
    apply();
    return () => window.removeEventListener("hashchange", apply);
  }, []);

  useEffect(() => {
    document.title = `${topic.title} — T4 Code docs`;
  }, [topic]);

  // Global Cmd/Ctrl+K toggles search.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((wasOpen) => {
          if (!wasOpen) {
            lastFocusRef.current = document.activeElement as HTMLElement | null;
          }
          return !wasOpen;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    (lastFocusRef.current ?? searchTriggerRef.current)?.focus();
    lastFocusRef.current = null;
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    menuTriggerRef.current?.focus();
  }, []);

  const flatIndex = DOC_TOPICS.findIndex((t) => t.id === topic.id);
  const prev = flatIndex > 0 ? DOC_TOPICS[flatIndex - 1] : undefined;
  const next = flatIndex < DOC_TOPICS.length - 1 ? DOC_TOPICS[flatIndex + 1] : undefined;
  const tocEntries = topic.blocks.filter(
    (block): block is Extract<Block, { kind: "h2" }> => block.kind === "h2",
  );

  return (
    <>
      <a className="skip-link" href="#doc-article">
        Skip to content
      </a>
      <header className="topbar">
        <div className="container topbar-inner">
          <button
            ref={menuTriggerRef}
            type="button"
            className="btn btn-outline btn-small menu-btn"
            aria-label="Open documentation menu"
            onClick={() => setDrawerOpen(true)}
          >
            Menu
          </button>
          <a className="wordmark" href="/">
            <img src="/omp-mark.svg" alt="" width="26" height="20" />
            T4 Code <span className="docs-suffix">docs</span>
          </a>
          <nav className="topbar-nav" aria-label="Site">
            <button
              ref={searchTriggerRef}
              type="button"
              className="search-trigger"
              onClick={() => {
                lastFocusRef.current = searchTriggerRef.current;
                setSearchOpen(true);
              }}
            >
              Search
              <kbd>{navigator.platform.includes("Mac") ? "⌘K" : "Ctrl K"}</kbd>
            </button>
            <a href={REPO_URL} rel="noopener" className="hide-narrow">
              GitHub
            </a>
          </nav>
        </div>
      </header>

      <div className="container docs-shell">
        <aside className="docs-sidebar">
          <SidebarNav activeId={topic.id} />
        </aside>

        <main className="docs-article" id="doc-article">
          <article aria-labelledby={topic.id}>
            <h1 id={topic.id}>{topic.title}</h1>
            <p>{renderInline(topic.lede)}</p>
            {topic.blocks.map((block, i) => renderBlock(block, i))}
          </article>
          <nav className="docs-pager" aria-label="Previous and next page">
            {prev ? (
              <a href={`#${prev.id}`}>
                <span className="pager-label">Previous</span>
                {prev.title}
              </a>
            ) : (
              <span />
            )}
            {next && (
              <a href={`#${next.id}`} className="pager-next">
                <span className="pager-label">Next</span>
                {next.title}
              </a>
            )}
          </nav>
        </main>

        <aside className="docs-toc" aria-label="On this page">
          {tocEntries.length > 0 && (
            <>
              <p className="toc-title">On this page</p>
              <ul>
                {tocEntries.map((entry) => (
                  <li key={entry.id}>
                    <a
                      href={`#${entry.id}`}
                      aria-current={currentHash === `#${entry.id}` ? "true" : undefined}
                    >
                      {plainText(entry.text)}
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
      </div>

      <SearchDialog open={searchOpen} onClose={closeSearch} />
      <Drawer open={drawerOpen} onClose={closeDrawer} activeId={topic.id} />
    </>
  );
}
