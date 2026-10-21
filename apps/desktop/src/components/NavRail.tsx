import type { Area } from "../areas";
import { useLongPress } from "../useLongPress";

interface NavRailProps {
  areas: readonly Area[];
  activeAreaId: string;
  onSelectArea: (id: string) => void;
  /** Wird nach drei Sekunden Gedrückthalten des Logos aufgerufen. */
  onOpenHiddenArea: () => void;
}

const LONG_PRESS_MS = 3000;

export function NavRail({ areas, activeAreaId, onSelectArea, onOpenHiddenArea }: NavRailProps) {
  const longPress = useLongPress(onOpenHiddenArea, LONG_PRESS_MS);
  const upperAreas = areas.filter((area) => area.placement !== "bottom");
  const lowerAreas = areas.filter((area) => area.placement === "bottom");

  function renderItem(area: Area) {
    const active = area.id === activeAreaId;
    return (
      <li key={area.id}>
        <button
          type="button"
          className={active ? "nav-rail-item is-active" : "nav-rail-item"}
          aria-current={active ? "page" : undefined}
          onClick={() => onSelectArea(area.id)}
        >
          {area.icon}
          <span>{area.label}</span>
        </button>
      </li>
    );
  }

  return (
    <nav className="nav-rail" aria-label="Bereiche">
      <div className="nav-rail-brand">
        {/* Werkstattlogo: drei Sekunden Gedrückthalten öffnet den versteckten
            Bereich. Während des Haltens gibt es bewusst keinerlei sichtbare
            Rückmeldung – das ist versteckte Bedienung, kein Zugriffsschutz. */}
        <div className="app-logo" aria-hidden="true" {...longPress}>
          <img src="/werkstatt-motion-mark.png" alt="" draggable="false" />
        </div>
      </div>
      <ul className="nav-rail-list">{upperAreas.map(renderItem)}</ul>
      {lowerAreas.length > 0 && (
        <ul className="nav-rail-list nav-rail-list-bottom">{lowerAreas.map(renderItem)}</ul>
      )}
    </nav>
  );
}
