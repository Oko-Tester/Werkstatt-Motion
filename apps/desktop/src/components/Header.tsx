import { useEffect, useRef, useState } from "react";
import type { Ref } from "react";
import { PrimaryButton } from "./PrimaryButton";
import { SearchInput } from "./SearchInput";

interface HeaderProps {
  search: string;
  onSearchChange: (value: string) => void;
  onAddVehicle: () => void;
  onBackup: () => void;
  searchRef?: Ref<HTMLInputElement>;
}

const BACKUP_STATUS_MS = 4000;

export function Header({ search, onSearchChange, onAddVehicle, onBackup, searchRef }: HeaderProps) {
  const [backupStatus, setBackupStatus] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    },
    [],
  );

  function handleBackupClick() {
    onBackup();
    setBackupStatus("Backup erstellt");
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => setBackupStatus(null), BACKUP_STATUS_MS);
  }

  return (
    <header className="app-header">
      {/* Platzhalter für das Werkstattlogo – später Halte-Ziel für den versteckten Bereich */}
      <div className="app-logo" aria-hidden="true">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
      </div>
      <h1 className="app-title">Werkstatt Manager</h1>
      <div className="header-search">
        <SearchInput value={search} onChange={onSearchChange} inputRef={searchRef} />
      </div>
      <div className="header-actions">
        <span className="backup-status" role="status">
          {backupStatus}
        </span>
        <button type="button" className="btn btn-secondary" onClick={handleBackupClick}>
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
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" x2="12" y1="15" y2="3" />
          </svg>
          Backup
        </button>
        <PrimaryButton onClick={onAddVehicle}>+ Fahrzeug</PrimaryButton>
      </div>
    </header>
  );
}
