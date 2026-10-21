import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { UndoBar } from "../components/UndoBar";

interface UndoState {
  id: number;
  message: string;
  undo: () => void;
}

const UNDO_TIMEOUT_MS = 6000;
const NOTICE_TIMEOUT_MS = 6000;

export interface Feedback {
  /** Zeigt kurz eine nicht blockierende Fehlermeldung. */
  showNotice: (message: string) => void;
  /** Zeigt die Rückgängig-Leiste für die letzte Aktion. */
  showUndo: (message: string, undo: () => void) => void;
  /** Blendet die Rückgängig-Leiste aus. */
  clearUndo: () => void;
}

const FeedbackContext = createContext<Feedback | null>(null);

/**
 * Meldungen und Rückgängig-Leiste der ganzen App. Jeder Bereich meldet über
 * `useFeedback()`; die Anzeige selbst gehört zu keinem Bereich.
 */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [undoState, setUndoState] = useState<UndoState | null>(null);
  const [notice, setNotice] = useState<{ id: number; message: string } | null>(null);
  const counterRef = useRef(0);

  useEffect(() => {
    if (!undoState) {
      return;
    }
    const timer = window.setTimeout(() => setUndoState(null), UNDO_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [undoState]);

  useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = window.setTimeout(() => setNotice(null), NOTICE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const feedback: Feedback = {
    showNotice(message) {
      counterRef.current += 1;
      setNotice({ id: counterRef.current, message });
    },
    showUndo(message, undo) {
      counterRef.current += 1;
      setUndoState({ id: counterRef.current, message, undo });
    },
    clearUndo() {
      setUndoState(null);
    },
  };

  return (
    <FeedbackContext.Provider value={feedback}>
      {children}
      {notice !== null && (
        <div key={notice.id} className="error-notice" role="alert">
          {notice.message}
        </div>
      )}
      {undoState !== null && (
        <UndoBar
          key={undoState.id}
          message={undoState.message}
          onUndo={undoState.undo}
          onDismiss={() => setUndoState(null)}
        />
      )}
    </FeedbackContext.Provider>
  );
}

export function useFeedback(): Feedback {
  const feedback = useContext(FeedbackContext);
  if (feedback === null) {
    throw new Error("useFeedback braucht einen FeedbackProvider");
  }
  return feedback;
}
