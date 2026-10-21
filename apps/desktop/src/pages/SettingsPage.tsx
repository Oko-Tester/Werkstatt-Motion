import { useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { useAreas } from "../state/AreasProvider";
import { HeaderStart } from "../state/headerSlots";

interface SettingsEntry {
  id: string;
  label: string;
  icon: ReactNode;
  Settings?: ComponentType;
}

/**
 * Einstellungen: Jeder Bereich der App steht einzeln in einer Liste. Rechts steht,
 * was zum gewählten Eintrag gehört. Ein Bereich bringt seine Einstellungen über
 * `Settings` in der Bereichsliste mit; ohne sie zeigt die Seite einen Hinweis.
 * Neue Bereiche erscheinen hier von selbst.
 */
export function SettingsPage() {
  const entries: SettingsEntry[] = useAreas().filter((area) => area.Page !== SettingsPage);
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
          {entries.map((entry) => {
            const active = entry.id === selected?.id;
            return (
              <li key={entry.id}>
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
