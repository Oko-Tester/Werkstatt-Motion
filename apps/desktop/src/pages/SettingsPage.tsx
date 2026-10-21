import { useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { useAreas } from "../state/AreasProvider";
import { HeaderStart } from "../state/headerSlots";
import { BackupSettings } from "./BackupSettings";

interface SettingsEntry {
  id: string;
  label: string;
  icon: ReactNode;
  Settings?: ComponentType;
}

/** Einstellungen, die zur ganzen App gehören statt zu einem Bereich. */
const GENERAL_ENTRIES: readonly SettingsEntry[] = [
  {
    id: "backup",
    label: "Datensicherung",
    icon: (
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
        <line x1="22" x2="2" y1="12" y2="12" />
        <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
        <line x1="6" x2="6.01" y1="16" y2="16" />
        <line x1="10" x2="10.01" y1="16" y2="16" />
      </svg>
    ),
    Settings: BackupSettings,
  },
];

/**
 * Einstellungen: Jeder Bereich der App steht einzeln in einer Liste, darunter
 * die Einstellungen der ganzen App (z. B. die Datensicherung). Rechts steht, was
 * zum gewählten Eintrag gehört. Ein Bereich bringt seine Einstellungen über
 * `Settings` in der Bereichsliste mit; ohne sie zeigt die Seite einen Hinweis.
 * Neue Bereiche erscheinen hier von selbst.
 */
export function SettingsPage() {
  const areaEntries: SettingsEntry[] = useAreas().filter((area) => area.Page !== SettingsPage);
  const entries = [...areaEntries, ...GENERAL_ENTRIES];
  const [selectedId, setSelectedId] = useState(entries[0]?.id);
  const selected = entries.find((entry) => entry.id === selectedId) ?? entries[0];
  const SelectedSettings = selected?.Settings;

  return (
    <section className="settings-workspace" aria-label="Einstellungen">
      <HeaderStart>
        <div className="header-heading">
          <h2>Einstellungen</h2>
          <p>Für jeden Bereich und für die ganze App</p>
        </div>
      </HeaderStart>
      <div className="settings-layout">
        <ul className="settings-areas" aria-label="Einstellungsgruppen">
          {entries.map((entry, index) => {
            const active = entry.id === selected?.id;
            const startsGeneral = index > 0 && index === areaEntries.length;
            return (
              <li key={entry.id} className={startsGeneral ? "settings-group-start" : undefined}>
                <button
                  type="button"
                  className={active ? "settings-area-item is-active" : "settings-area-item"}
                  aria-current={active ? "true" : undefined}
                  onClick={() => setSelectedId(entry.id)}
                >
                  {entry.icon}
                  {entry.label}
                </button>
              </li>
            );
          })}
        </ul>
        {selected !== undefined && (
          <section className="settings-detail" aria-label={`Einstellungen für ${selected.label}`}>
            <h3>{selected.label}</h3>
            {SelectedSettings ? (
              <SelectedSettings />
            ) : (
              <p className="settings-empty">Für diesen Bereich gibt es noch keine Einstellungen.</p>
            )}
          </section>
        )}
      </div>
    </section>
  );
}
