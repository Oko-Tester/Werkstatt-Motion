import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

interface HeaderSlots {
  start: HTMLElement | null;
  actions: HTMLElement | null;
  setStart: (node: HTMLElement | null) => void;
  setActions: (node: HTMLElement | null) => void;
}

const HeaderSlotsContext = createContext<HeaderSlots | null>(null);

/**
 * Die Kopfzeile gehört der App, ihr Inhalt dem aktiven Bereich: Die Kopfzeile
 * stellt zwei Plätze bereit, links und rechts. Die Seite des Bereichs setzt
 * ihre Teile mit `<HeaderStart>` und `<HeaderActions>` dorthin, bleibt dabei
 * aber in ihrer eigenen Komponente und kann deren Zustand direkt nutzen.
 * Verlässt man den Bereich, verschwinden seine Teile von selbst.
 */
export function HeaderSlotsProvider({ children }: { children: ReactNode }) {
  const [start, setStart] = useState<HTMLElement | null>(null);
  const [actions, setActions] = useState<HTMLElement | null>(null);
  return (
    <HeaderSlotsContext.Provider value={{ start, actions, setStart, setActions }}>
      {children}
    </HeaderSlotsContext.Provider>
  );
}

function useHeaderSlots(): HeaderSlots {
  const slots = useContext(HeaderSlotsContext);
  if (slots === null) {
    throw new Error("Die Kopfzeile braucht einen HeaderSlotsProvider");
  }
  return slots;
}

/** Für die Kopfzeile selbst: meldet ihre beiden Plätze an. */
export function useHeaderSlotRefs() {
  const { setStart, setActions } = useHeaderSlots();
  return { startRef: setStart, actionsRef: setActions };
}

/** Setzt Inhalt links in die Kopfzeile, z. B. Titel oder Suche. */
export function HeaderStart({ children }: { children: ReactNode }) {
  const { start } = useHeaderSlots();
  return start === null ? null : createPortal(children, start);
}

/** Setzt Inhalt rechts in die Kopfzeile, z. B. Schaltflächen. */
export function HeaderActions({ children }: { children: ReactNode }) {
  const { actions } = useHeaderSlots();
  return actions === null ? null : createPortal(children, actions);
}
