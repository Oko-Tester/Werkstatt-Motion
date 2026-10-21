import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import { toApiError } from "../api";
import { parseEuroInput } from "../money";
import type { HiddenEntry, HiddenEntryDraft, HiddenStatus, HiddenTextField } from "../types";
import type { Feedback } from "./feedback";
import type { DraftSupport } from "./useDraftSupport";
import { isDraftId } from "./useDraftSupport";

function isHiddenDraftComplete(draft: HiddenEntryDraft): boolean {
  return draft.name.trim() !== "" && draft.amountCents !== null && draft.amountCents > 0;
}

function isHiddenDraftEmpty(draft: HiddenEntryDraft): boolean {
  return draft.name.trim() === "" && draft.amountCents === null && draft.note.trim() === "";
}

interface SecretAreaDeps {
  feedback: Feedback;
  drafts: DraftSupport;
}

/**
 * Der versteckte Bereich: Sitzung, Einträge und neue Zeilen. Die Sitzung gehört
 * keinem einzelnen Bereich – die Fahrzeugseite zeigt die Einträge, die Historie
 * den Verlauf. Deshalb lebt sie über Bereichswechsel hinweg.
 */
export function useSecretArea({ feedback, drafts }: SecretAreaDeps) {
  const { showNotice, showUndo, clearUndo } = feedback;
  const { clearFieldError, setFieldError, fieldErrorsRef, setFieldErrors, creatingRef, setAutoFocusId } =
    drafts;
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [secretSessionToken, setSecretSessionToken] = useState<string | null>(null);
  const [hiddenStatus, setHiddenStatus] = useState<HiddenStatus | null>(null);
  const [hiddenEntries, setHiddenEntries] = useState<HiddenEntry[]>([]);
  const [hiddenDrafts, setHiddenDrafts] = useState<HiddenEntryDraft[]>([]);
  // Zählt jedes Öffnen und Schließen der Sitzung. Die Historie lädt sich
  // daraufhin neu, weil sich ändert, was sie zeigen darf.
  const [revision, setRevision] = useState(0);

  // Spiegel der States für Handler, die nach dem Event (setTimeout) den
  // aktuellen Stand brauchen – z. B. das Verwerfen leerer Entwurfszeilen.
  const hiddenEntriesRef = useRef(hiddenEntries);
  hiddenEntriesRef.current = hiddenEntries;
  const hiddenDraftsRef = useRef(hiddenDrafts);
  hiddenDraftsRef.current = hiddenDrafts;
  const hiddenOpenRef = useRef(hiddenOpen);
  hiddenOpenRef.current = hiddenOpen;
  const secretSessionTokenRef = useRef(secretSessionToken);
  secretSessionTokenRef.current = secretSessionToken;

  const secretOpeningRef = useRef(false);

  useEffect(
    () => () => {
      const token = secretSessionTokenRef.current;
      if (token !== null) void api.endSecretSession(token).catch(() => undefined);
    },
    [],
  );

  // ---------- Versteckter Bereich ----------

  function openHiddenArea() {
    // Mehrfachauslösung während oder nach dem Session-Start ist wirkungslos.
    if (hiddenOpenRef.current || secretOpeningRef.current) return;
    secretOpeningRef.current = true;
    void beginAndLoadSecretArea();
  }

  async function beginAndLoadSecretArea() {
    try {
      const token = await api.beginSecretSession();
      secretSessionTokenRef.current = token;
      setSecretSessionToken(token);
      hiddenOpenRef.current = true;
      setHiddenOpen(true);
      setHiddenStatus({ unlocked: true });
      const entries = await api.listHiddenEntries(token);
      if (secretSessionTokenRef.current === token) {
        setHiddenEntries(entries);
        // Eine geöffnete Historie lädt sich neu und blendet die Secret-Einträge ein.
        setRevision((value) => value + 1);
      }
    } catch (err) {
      // Auch ein Schlüssel-/Sessionfehler bleibt als sicherer, gesperrter Zustand sichtbar.
      if (secretSessionTokenRef.current === null) {
        hiddenOpenRef.current = true;
        setHiddenOpen(true);
      }
      setHiddenStatus({ unlocked: false, error: toApiError(err) });
      setHiddenEntries([]);
    } finally {
      secretOpeningRef.current = false;
    }
  }

  async function reloadHiddenEntries(token = secretSessionTokenRef.current) {
    if (token === null) return;
    try {
      const entries = await api.listHiddenEntries(token);
      if (secretSessionTokenRef.current === token) {
        setHiddenStatus({ unlocked: true });
        setHiddenEntries(entries);
      }
    } catch (err) {
      if (secretSessionTokenRef.current === token) {
        setHiddenStatus({ unlocked: false, error: toApiError(err) });
        setHiddenEntries([]);
      }
    }
  }

  function closeHiddenArea() {
    const token = secretSessionTokenRef.current;
    // Erst synchron alle Secret-Klartextdaten entfernen, dann best-effort beenden.
    // Eine bereits geöffnete öffentliche Fahrzeughistorie bleibt sichtbar.
    secretSessionTokenRef.current = null;
    hiddenOpenRef.current = false;
    setSecretSessionToken(null);
    setHiddenOpen(false);
    setHiddenStatus(null);
    setHiddenEntries([]);
    setHiddenDrafts([]);
    clearUndo();
    setAutoFocusId(null);
    setFieldErrors((previous) => {
      const next = { ...previous };
      for (const draft of hiddenDraftsRef.current) delete next[draft.draftId];
      for (const entry of hiddenEntriesRef.current) delete next[entry.id];
      return next;
    });
    hiddenEntriesRef.current = [];
    hiddenDraftsRef.current = [];
    if (token !== null) void api.endSecretSession(token).catch(() => undefined);
    // Eine geöffnete Historie lädt sich neu und lässt die Secret-Einträge weg.
    setRevision((value) => value + 1);
  }

  function addHiddenEntry() {
    if (secretSessionTokenRef.current === null) return;
    const draft: HiddenEntryDraft = {
      draftId: `draft-h-${crypto.randomUUID()}`,
      name: "",
      amountCents: null,
      note: "",
    };
    setHiddenDrafts((prev) => [draft, ...prev]);
    setAutoFocusId(draft.draftId);
  }

  function updateHiddenDraft(draftId: string, patch: Partial<HiddenEntryDraft>) {
    const current = hiddenDraftsRef.current.find((draft) => draft.draftId === draftId);
    if (!current) {
      return;
    }
    const next = { ...current, ...patch };
    setHiddenDrafts((prev) => prev.map((draft) => (draft.draftId === draftId ? next : draft)));
    for (const field of Object.keys(patch)) {
      clearFieldError(draftId, field);
    }
  }

  async function createHiddenFromDraft(draft: HiddenEntryDraft) {
    const token = secretSessionTokenRef.current;
    if (token === null) {
      creatingRef.current.delete(draft.draftId);
      return;
    }
    try {
      const created = await api.createHiddenEntry(token, {
        name: draft.name,
        amountCents: draft.amountCents ?? 0,
        note: draft.note,
      });
      if (secretSessionTokenRef.current !== token) return;
      setHiddenDrafts((prev) => prev.filter((entry) => entry.draftId !== draft.draftId));
      clearFieldError(draft.draftId);
      setHiddenEntries((prev) => [...prev, created]);
    } catch (err) {
      if (secretSessionTokenRef.current === token) {
        const apiErr = toApiError(err);
        setFieldError(draft.draftId, apiErr.field ?? "name", apiErr.message);
      }
    } finally {
      creatingRef.current.delete(draft.draftId);
    }
  }

  function handleHiddenDraftRowLeave(draftId: string) {
    window.setTimeout(() => {
      const draft = hiddenDraftsRef.current.find((entry) => entry.draftId === draftId);
      if (!draft || creatingRef.current.has(draftId)) {
        return;
      }
      if (isHiddenDraftEmpty(draft)) {
        setHiddenDrafts((prev) => prev.filter((entry) => entry.draftId !== draftId));
        clearFieldError(draftId);
      } else if (isHiddenDraftComplete(draft)) {
        creatingRef.current.add(draftId);
        void createHiddenFromDraft(draft);
      } else {
        const existing = fieldErrorsRef.current[draftId] ?? {};
        if (draft.name.trim() === "" && existing.name === undefined) {
          setFieldError(draftId, "name", "Bezeichnung angeben");
        } else if (draft.name.trim() !== "" && existing.amountCents === undefined) {
          setFieldError(draftId, "amountCents", "Betrag angeben");
        }
      }
    }, 0);
  }

  function commitHiddenText(id: string, field: HiddenTextField, value: string) {
    if (isDraftId(id)) {
      updateHiddenDraft(id, { [field]: value });
      return;
    }
    void saveHiddenPatch(id, { [field]: value });
  }

  function commitHiddenAmount(id: string, raw: string) {
    if (raw === "") {
      if (isDraftId(id)) {
        updateHiddenDraft(id, { amountCents: null });
      } else {
        setFieldError(id, "amountCents", "Betrag angeben");
      }
      return;
    }
    const cents = parseEuroInput(raw);
    if (cents === null || cents <= 0) {
      setFieldError(id, "amountCents", "Ungültiger Betrag, z. B. 486,50");
      return;
    }
    clearFieldError(id, "amountCents");
    if (isDraftId(id)) {
      updateHiddenDraft(id, { amountCents: cents });
    } else {
      void saveHiddenPatch(id, { amountCents: cents });
    }
  }

  async function saveHiddenPatch(id: string, patch: api.HiddenEntryPatch) {
    const token = secretSessionTokenRef.current;
    if (token === null) return;
    const entry = hiddenEntriesRef.current.find((item) => item.id === id);
    if (!entry) {
      return;
    }
    const fields = Object.keys(patch);
    for (const field of fields) {
      clearFieldError(id, field);
    }
    const unchanged = fields.every(
      (field) =>
        entry[field as keyof api.HiddenEntryPatch] === patch[field as keyof api.HiddenEntryPatch],
    );
    if (unchanged) {
      return;
    }
    const previous = entry;
    setHiddenEntries((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
    try {
      const saved = await api.updateHiddenEntry(token, id, patch);
      if (secretSessionTokenRef.current === token) {
        setHiddenEntries((prev) => prev.map((item) => (item.id === id ? saved : item)));
      }
    } catch (err) {
      if (secretSessionTokenRef.current === token) {
        const apiErr = toApiError(err);
        setHiddenEntries((prev) => prev.map((item) => (item.id === id ? previous : item)));
        setFieldError(id, apiErr.field ?? fields[0] ?? "name", apiErr.message);
      }
    }
  }

  function archiveHiddenEntry(id: string) {
    if (isDraftId(id)) {
      setHiddenDrafts((prev) => prev.filter((entry) => entry.draftId !== id));
      clearFieldError(id);
      return;
    }
    void archiveStoredHiddenEntry(id);
  }

  async function archiveStoredHiddenEntry(id: string) {
    const token = secretSessionTokenRef.current;
    if (token === null) return;
    const entry = hiddenEntriesRef.current.find((item) => item.id === id);
    if (!entry) {
      return;
    }
    const previousList = hiddenEntriesRef.current;
    setHiddenEntries((prev) => prev.filter((item) => item.id !== id));
    try {
      await api.archiveHiddenEntry(token, id);
      if (secretSessionTokenRef.current !== token) return;
      const name = entry.name || "Eintrag";
      showUndo(`${name} archiviert`, () => {
        clearUndo();
        void undoArchiveHiddenEntry(id);
      });
    } catch (err) {
      if (secretSessionTokenRef.current === token) {
        setHiddenEntries(previousList);
        showNotice(toApiError(err).message);
      }
    }
  }

  async function undoArchiveHiddenEntry(id: string) {
    const token = secretSessionTokenRef.current;
    if (token === null) return;
    try {
      await api.restoreHiddenEntry(token, id);
      await reloadHiddenEntries(token);
    } catch (err) {
      if (secretSessionTokenRef.current === token) showNotice(toApiError(err).message);
    }
  }

  const unlocked = secretSessionToken !== null && hiddenStatus?.unlocked === true;

  return {
    isOpen: hiddenOpen,
    unlocked,
    sessionToken: secretSessionToken,
    sessionTokenRef: secretSessionTokenRef,
    status: hiddenStatus,
    entries: hiddenEntries,
    drafts: hiddenDrafts,
    revision,
    open: openHiddenArea,
    close: closeHiddenArea,
    add: addHiddenEntry,
    commitText: commitHiddenText,
    commitAmount: commitHiddenAmount,
    archive: archiveHiddenEntry,
    onDraftRowLeave: handleHiddenDraftRowLeave,
  };
}
