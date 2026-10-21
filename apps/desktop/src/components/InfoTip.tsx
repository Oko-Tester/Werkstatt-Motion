import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

interface InfoTipProps {
  /** Wozu die Info gehört (z. B. „Zweiter Speicherort“); steht im Namen des Knopfs. */
  label: string;
  children: ReactNode;
}

/**
 * Kleiner Info-Knopf für Erklärungen, die nicht ständig im Weg stehen sollen.
 * Die Sprechblase erscheint beim Darüberfahren und bleibt nach einem Klick
 * offen (so lässt sich ihr Text auch markieren); ein weiterer Klick, Esc oder
 * ein Klick daneben schließt sie wieder.
 */
export function InfoTip({ label, children }: InfoTipProps) {
  const bubbleId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hovered || pinned;

  useEffect(() => {
    if (!pinned) return;
    function closeOnPressOutside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setPinned(false);
    }
    document.addEventListener("pointerdown", closeOnPressOutside);
    return () => document.removeEventListener("pointerdown", closeOnPressOutside);
  }, [pinned]);

  function toggle() {
    if (pinned) {
      // Der Zeiger steht noch auf dem Knopf: Erst beim nächsten Darüberfahren
      // soll die Blase von selbst wieder aufgehen.
      setPinned(false);
      setHovered(false);
    } else {
      setPinned(true);
    }
  }

  return (
    <span
      ref={rootRef}
      className="info-tip"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setPinned(false);
          setHovered(false);
        }
      }}
      onBlur={(event) => {
        // Wer per Tab weitergeht, lässt keine offene Blase zurück.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPinned(false);
      }}
    >
      <button
        type="button"
        className="info-tip-button"
        aria-label={`Info: ${label}`}
        aria-expanded={open}
        aria-describedby={open ? bubbleId : undefined}
        onClick={toggle}
      >
        <svg
          aria-hidden="true"
          focusable="false"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <circle cx="8" cy="8" r="6.5" />
          <path d="M8 7.4v3.6" />
          <circle cx="8" cy="5.1" r="0.6" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <span id={bubbleId} role="tooltip" tabIndex={-1} className="info-tip-bubble">
          {children}
        </span>
      )}
    </span>
  );
}
