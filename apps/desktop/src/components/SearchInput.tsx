import type { Ref } from "react";

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  inputRef?: Ref<HTMLInputElement>;
}

export function SearchInput({ value, onChange, inputRef }: SearchInputProps) {
  return (
    <div className="search-input">
      <svg
        className="search-input-icon"
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
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
      </svg>
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Kunde, Fahrzeug oder Kennzeichen suchen"
        aria-label="Fahrzeuge durchsuchen"
      />
    </div>
  );
}
