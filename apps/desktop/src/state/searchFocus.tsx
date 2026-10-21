import { createContext, useContext, useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";

const SearchFocusContext = createContext<RefObject<HTMLInputElement | null> | null>(null);

/**
 * Strg+F bzw. Cmd+F fokussiert die Suche des aktiven Bereichs statt der
 * WebView-Suche. Welches Feld das ist, entscheidet der Bereich: Er hängt
 * `useAreaSearchRef()` an sein Suchfeld. Ohne Suchfeld passiert nichts.
 */
export function SearchFocusProvider({ children }: { children: ReactNode }) {
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return <SearchFocusContext.Provider value={searchRef}>{children}</SearchFocusContext.Provider>;
}

export function useAreaSearchRef(): RefObject<HTMLInputElement | null> {
  const searchRef = useContext(SearchFocusContext);
  if (searchRef === null) {
    throw new Error("useAreaSearchRef braucht einen SearchFocusProvider");
  }
  return searchRef;
}
