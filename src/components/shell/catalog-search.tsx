"use client";

import Link from "next/link";
import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import styles from "./app-shell.module.css";

export interface CatalogSearchItem {
  readonly id: string;
  readonly title: string;
  readonly courseTitle: string;
  readonly href: string;
}

export function CatalogSearch({ catalog, onNavigate, onShortcut }: {
  catalog: readonly CatalogSearchItem[];
  onNavigate: () => void;
  onShortcut?: () => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onShortcut?.();
        // Let the shell open its mobile drawer before focusing an inert input.
        queueMicrotask(() => inputRef.current?.focus());
      }
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [onShortcut]);
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const results = tokens.length ? catalog.filter((item) => {
    const text = `${item.title} ${item.courseTitle} ${item.id}`.toLocaleLowerCase();
    return tokens.every((token) => text.includes(token));
  }) : [];
  return <div className={styles.catalogSearch} onKeyDown={(event) => {
    if (event.key === "Escape") { event.stopPropagation(); setQuery(""); inputRef.current?.focus(); }
  }}>
    <label className={styles.searchBox}>
      <Search size={16} aria-hidden="true" />
      <input ref={inputRef} type="search" aria-label="Search courses and skills" aria-controls={tokens.length ? "catalog-search-results" : undefined} aria-keyshortcuts="Control+k Meta+k" placeholder="Search courses and skills" value={query} onChange={(event) => setQuery(event.target.value)} />
    </label>
    {tokens.length > 0 && <div id="catalog-search-results" className={styles.searchResults}>
      <p role="status">{results.length ? `${results.length} results` : "No courses or skills found. Try another search."}</p>
      {results.length > 0 && <ul>{results.map((item) => <li key={item.href}><Link href={item.href} onClick={() => { setQuery(""); onNavigate(); }}>{item.title} · {item.courseTitle}</Link></li>)}</ul>}
    </div>}
  </div>;
}
