import type { ComponentType, ReactNode } from "react";
import { CalendarPage } from "./pages/CalendarPage";
import { HistoryPage } from "./pages/HistoryPage";
import { SettingsPage } from "./pages/SettingsPage";
import { VehiclesPage } from "./pages/VehiclesPage";
import { VehiclesSettings } from "./pages/VehiclesSettings";

export interface Area {
  /** Eindeutige Kennung, nur intern. */
  id: string;
  /** Beschriftung unter dem Symbol. Kurz halten, die Leiste ist schmal. */
  label: string;
  icon: ReactNode;
  /** Die Seite des Bereichs. Sie holt sich ihre Daten selbst. */
  Page: ComponentType;
  /**
   * Die Einstellungen des Bereichs. Sie erscheinen unter „Einstellungen“;
   * ohne Angabe steht dort ein Hinweis, dass es noch keine gibt.
   */
  Settings?: ComponentType;
  /** `"bottom"` setzt den Bereich ans Ende der Leiste, abgesetzt von den übrigen. */
  placement?: "bottom";
}

function AreaIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/**
 * Die Bereichsliste. Die Leiste links und die Seite daneben werden allein aus
 * ihr gebaut. Ein neuer Bereich ist ein weiterer Eintrag:
 *
 * 1. Seite anlegen: `pages/MeineSeite.tsx` exportiert eine Komponente ohne
 *    Eigenschaften. Eigene Daten lädt sie selbst über `api`; Meldungen und
 *    „Rückgängig“ kommen aus `useFeedback()`, gemeinsame Daten wie die
 *    Fahrzeuge aus `useWorkshop()`.
 * 2. Eintrag unten ergänzen: Kennung, Name, Symbol und Seite.
 * 3. Die Kopfzeile füllt die Seite selbst: `<HeaderStart>` setzt Inhalt nach
 *    links (Titel, Suche), `<HeaderActions>` nach rechts (Schaltflächen). Beides
 *    ist optional und verschwindet mit dem Bereich.
 * 4. Nur wenn der Bereich Einstellungen hat: `Settings` ergänzen. Der Bereich
 *    steht auch ohne unter „Einstellungen“ und zeigt dort einen Hinweis.
 *
 * Zustand, der einen Bereichswechsel überleben soll oder von mehreren
 * Bereichen gebraucht wird, gehört nach `state/`. Alles andere in die Seite.
 */
export const AREAS: readonly Area[] = [
  {
    id: "vehicles",
    label: "Fahrzeuge",
    icon: (
      <AreaIcon>
        <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2" />
        <circle cx="7" cy="17" r="2" />
        <path d="M9 17h6" />
        <circle cx="17" cy="17" r="2" />
      </AreaIcon>
    ),
    Page: VehiclesPage,
    Settings: VehiclesSettings,
  },
  {
    id: "calendar",
    label: "Kalender",
    icon: (
      <AreaIcon>
        <path d="M8 2v4" />
        <path d="M16 2v4" />
        <rect width="18" height="18" x="3" y="4" rx="2" />
        <path d="M3 10h18" />
      </AreaIcon>
    ),
    Page: CalendarPage,
  },
  {
    id: "history",
    label: "Historie",
    icon: (
      <AreaIcon>
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
        <path d="M3 3v5h5" />
        <path d="M12 7v5l4 2" />
      </AreaIcon>
    ),
    Page: HistoryPage,
  },
  {
    id: "settings",
    label: "Einstellungen",
    icon: (
      <AreaIcon>
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </AreaIcon>
    ),
    Page: SettingsPage,
    placement: "bottom",
  },
];
