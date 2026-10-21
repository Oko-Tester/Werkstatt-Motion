import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { Area } from "../areas";

const AreasContext = createContext<readonly Area[] | null>(null);

/** Reicht die Bereichsliste an die Seiten weiter, z. B. an die Einstellungen. */
export function AreasProvider({
  areas,
  children,
}: {
  areas: readonly Area[];
  children: ReactNode;
}) {
  return <AreasContext.Provider value={areas}>{children}</AreasContext.Provider>;
}

export function useAreas(): readonly Area[] {
  const areas = useContext(AreasContext);
  if (areas === null) {
    throw new Error("useAreas braucht einen AreasProvider");
  }
  return areas;
}
