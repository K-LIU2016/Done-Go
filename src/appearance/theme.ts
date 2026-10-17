export const APPEARANCE_STORAGE_KEY = "tango-donego.appearance.v1";

export const APPEARANCE_THEMES = ["porcelain", "ink"] as const;

export type AppearanceTheme = (typeof APPEARANCE_THEMES)[number];

export type AppearanceIssue = "corrupted" | "read-failed" | "write-failed";

export interface AppearanceStatus {
  theme: AppearanceTheme;
  issue: AppearanceIssue | null;
}

export type ParsedAppearance =
  | { state: "absent" }
  | { state: "valid"; theme: AppearanceTheme }
  | { state: "corrupted"; raw: string };

export interface AppearanceStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface AppearanceDocumentLike {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export interface AppearanceStorePorts {
  storage: AppearanceStorageLike;
  doc?: AppearanceDocumentLike;
  resolveKey?: () => string;
}

export interface AppearanceStore {
  getStatus(): AppearanceStatus;
  subscribe(listener: () => void): () => void;
  setTheme(theme: AppearanceTheme): void;
  refreshFromStorage(): void;
}

export function parseStoredAppearance(raw: string | null): ParsedAppearance {
  if (raw === null) return { state: "absent" };
  if ((APPEARANCE_THEMES as readonly string[]).includes(raw)) {
    return { state: "valid", theme: raw as AppearanceTheme };
  }
  return { state: "corrupted", raw };
}

export function applyThemeToDocument(
  doc: AppearanceDocumentLike | undefined,
  theme: AppearanceTheme,
): void {
  if (!doc) return;
  if (theme === "ink") {
    doc.setAttribute("data-theme", "ink");
  } else {
    doc.removeAttribute("data-theme");
  }
}

export function createAppearanceStore(ports: AppearanceStorePorts): AppearanceStore {
  const { storage, doc, resolveKey } = ports;
  const storageKey = () => resolveKey?.() ?? APPEARANCE_STORAGE_KEY;
  let status: AppearanceStatus = { theme: "porcelain", issue: null };
  const listeners = new Set<() => void>();

  function update(next: AppearanceStatus): void {
    if (next.theme === status.theme && next.issue === status.issue) return;
    status = next;
    for (const listener of listeners) listener();
  }

  return {
    getStatus: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setTheme(theme) {
      applyThemeToDocument(doc, theme);
      let persisted = true;
      try {
        storage.setItem(storageKey(), theme);
      } catch {
        persisted = false;
      }
      update({ theme, issue: persisted ? null : "write-failed" });
    },
    refreshFromStorage() {
      let raw: string | null;
      try {
        raw = storage.getItem(storageKey());
      } catch {
        applyThemeToDocument(doc, "porcelain");
        update({ theme: "porcelain", issue: "read-failed" });
        return;
      }
      const parsed = parseStoredAppearance(raw);
      if (parsed.state === "valid") {
        applyThemeToDocument(doc, parsed.theme);
        update({ theme: parsed.theme, issue: null });
        return;
      }
      applyThemeToDocument(doc, "porcelain");
      update({
        theme: "porcelain",
        issue: parsed.state === "corrupted" ? "corrupted" : null,
      });
    },
  };
}

export class InMemoryStorage implements AppearanceStorageLike {
  #map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.#map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#map.set(key, value);
  }
}
