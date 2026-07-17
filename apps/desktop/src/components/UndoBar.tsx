interface UndoBarProps {
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
}

/** Kurzzeitig sichtbare Leiste nach Archivieren oder Bezahlen – ersetzt Bestätigungsdialoge. */
export function UndoBar({ message, onUndo, onDismiss }: UndoBarProps) {
  return (
    <div className="undo-bar" role="status">
      <span>{message}</span>
      <button type="button" className="undo-bar-action" onClick={onUndo}>
        Rückgängig
      </button>
      <button type="button" className="icon-button" aria-label="Hinweis schließen" onClick={onDismiss}>
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      </button>
    </div>
  );
}
