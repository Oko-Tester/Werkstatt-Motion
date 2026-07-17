import { useEffect, useRef } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";

export interface LongPressHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}

/**
 * Löst nach `durationMs` ununterbrochenem Gedrückthalten genau einmal aus.
 * Loslassen, Abbrechen oder Verlassen des Elements bricht den Timer ab;
 * normales Anklicken hat keine Wirkung. Bewusst ohne jede sichtbare
 * Rückmeldung während des Haltens (kein Ring, kein Balken, kein Countdown).
 * Funktioniert über Pointer-Events für Maus und Touch gleichermaßen.
 */
export function useLongPress(onLongPress: () => void, durationMs: number): LongPressHandlers {
  const timerRef = useRef<number | null>(null);
  const pressedRef = useRef(false);
  const callbackRef = useRef(onLongPress);
  callbackRef.current = onLongPress;

  const cancel = () => {
    pressedRef.current = false;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => cancel, []);

  return {
    onPointerDown(event) {
      // Nur die primäre Taste; ein weiterer Zeiger während desselben
      // Gedrückthaltens startet keinen zweiten Timer (keine Mehrfachauslösung).
      if ((event.button ?? 0) !== 0 || pressedRef.current) {
        return;
      }
      pressedRef.current = true;
      timerRef.current = window.setTimeout(() => {
        // Timer verbraucht: solange nicht losgelassen wird, feuert nichts erneut.
        timerRef.current = null;
        callbackRef.current();
      }, durationMs);
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
    onContextMenu(event) {
      // Touch-Long-Press darf kein Kontextmenü öffnen und sich damit verraten.
      event.preventDefault();
    },
  };
}
