import { useRef, useState } from "react";
import type { FieldErrors } from "../types";

export function isDraftId(id: string): boolean {
  return id.startsWith("draft-");
}

/**
 * Gemeinsame Hilfen aller Tabellen mit neuen Zeilen (Fahrzeuge, Zahlungen,
 * versteckte Einträge): Feldfehler, Fokus auf die neue Zeile und die Merkliste
 * der Zeilen, die gerade angelegt werden.
 */
export function useDraftSupport() {
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [autoFocusId, setAutoFocusId] = useState<string | null>(null);

  const fieldErrorsRef = useRef(fieldErrors);
  fieldErrorsRef.current = fieldErrors;
  const creatingRef = useRef(new Set<string>());

  function setFieldError(rowId: string, field: string, message: string) {
    setFieldErrors((prev) => ({ ...prev, [rowId]: { ...prev[rowId], [field]: message } }));
  }

  function clearFieldError(rowId: string, field?: string) {
    setFieldErrors((prev) => {
      if (!(rowId in prev)) {
        return prev;
      }
      const next = { ...prev };
      if (field === undefined) {
        delete next[rowId];
        return next;
      }
      const row = { ...next[rowId] };
      delete row[field];
      if (Object.keys(row).length === 0) {
        delete next[rowId];
      } else {
        next[rowId] = row;
      }
      return next;
    });
  }

  return {
    fieldErrors,
    fieldErrorsRef,
    setFieldErrors,
    setFieldError,
    clearFieldError,
    autoFocusId,
    setAutoFocusId,
    creatingRef,
  };
}

export type DraftSupport = ReturnType<typeof useDraftSupport>;
