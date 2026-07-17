interface StatusToggleProps {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
  tone?: "primary" | "attention" | "success";
}

/** Statuszelle: ein Klick schaltet um, Zustand wird durch Symbol und Farbe gezeigt. */
export function StatusToggle({ checked, label, onChange, tone = "primary" }: StatusToggleProps) {
  const className = checked ? `status-toggle is-on tone-${tone}` : "status-toggle";

  return (
    <button
      type="button"
      className={className}
      aria-pressed={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    >
      <span aria-hidden="true">{checked ? "✓" : "–"}</span>
    </button>
  );
}
