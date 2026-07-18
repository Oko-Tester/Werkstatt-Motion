import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { createPortal } from "react-dom";
import type { CustomerSuggestion } from "../types";
import { focusNextField } from "./InlineTextField";

interface CustomerAutocompleteProps {
  value: string;
  label: string;
  suggestions: CustomerSuggestion[];
  onCommit: (value: string) => void;
  onSelect?: (suggestion: CustomerSuggestion) => void;
  placeholder?: string;
  autoFocus?: boolean;
  error?: string;
}

interface SuggestionsPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

const SUGGESTIONS_GAP = 4;
const SUGGESTIONS_MARGIN = 8;
const SUGGESTIONS_MIN_WIDTH = 230;
const SUGGESTIONS_MAX_HEIGHT = 280;

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("de-DE");
}

function matchRank(customerName: string, query: string): number | null {
  const name = normalize(customerName);
  const needle = normalize(query);
  if (needle === "") return null;
  if (name === needle) return 0;
  if (name.startsWith(needle)) return 1;
  if (name.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(needle))) return 2;
  if (name.includes(needle)) return 3;
  return null;
}

/** Exakte fachliche Sortierung der Kundenvorschläge; maximal fünf Treffer. */
export function rankCustomerSuggestions(
  suggestions: CustomerSuggestion[],
  query: string,
): CustomerSuggestion[] {
  return suggestions
    .map((suggestion) => ({ suggestion, rank: matchRank(suggestion.customerName, query) }))
    .filter(
      (entry): entry is { suggestion: CustomerSuggestion; rank: number } => entry.rank !== null,
    )
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        b.suggestion.lastUsedAt.localeCompare(a.suggestion.lastUsedAt) ||
        a.suggestion.customerName.localeCompare(b.suggestion.customerName, "de-DE") ||
        a.suggestion.id.localeCompare(b.suggestion.id),
    )
    .slice(0, 5)
    .map((entry) => entry.suggestion);
}

/**
 * Nicht modales Kundenfeld für offene Zahlungen. Die Vorschläge werden nur aus
 * der bereits geladenen Liste gefiltert; während des Tippens gibt es keinen IPC-Aufruf.
 */
export function CustomerAutocomplete({
  value,
  label,
  suggestions,
  onCommit,
  onSelect,
  placeholder,
  autoFocus,
  error,
}: CustomerAutocompleteProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [suggestionsPosition, setSuggestionsPosition] =
    useState<SuggestionsPosition | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLUListElement>(null);
  const errorId = useId();
  const listId = useId();
  const currentValue = draft ?? value;
  const matches = useMemo(
    () => rankCustomerSuggestions(suggestions, currentValue),
    [suggestions, currentValue],
  );
  const showMatches = open && normalize(currentValue) !== "" && matches.length > 0;

  useEffect(() => {
    if (open && matches.length > 0 && activeIndex >= matches.length) setActiveIndex(0);
  }, [activeIndex, matches.length, open]);

  useLayoutEffect(() => {
    if (!showMatches) {
      setSuggestionsPosition(null);
      return;
    }

    function updatePosition() {
      const input = inputRef.current;
      const suggestionsList = suggestionsRef.current;
      if (input === null || suggestionsList === null) return;

      const inputRect = input.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
      const desiredHeight = Math.min(
        suggestionsList.scrollHeight || SUGGESTIONS_MAX_HEIGHT,
        SUGGESTIONS_MAX_HEIGHT,
      );
      const spaceBelow = viewportHeight - inputRect.bottom - SUGGESTIONS_MARGIN;
      const spaceAbove = inputRect.top - SUGGESTIONS_MARGIN;
      const openAbove = spaceBelow < desiredHeight && spaceAbove > spaceBelow;
      const availableHeight = Math.max(
        80,
        (openAbove ? spaceAbove : spaceBelow) - SUGGESTIONS_GAP,
      );
      const width = Math.min(
        Math.max(inputRect.width, SUGGESTIONS_MIN_WIDTH),
        viewportWidth - SUGGESTIONS_MARGIN * 2,
      );
      const left = Math.min(
        Math.max(SUGGESTIONS_MARGIN, inputRect.left),
        viewportWidth - width - SUGGESTIONS_MARGIN,
      );
      const renderedHeight = Math.min(desiredHeight, availableHeight);
      const top = openAbove
        ? Math.max(
            SUGGESTIONS_MARGIN,
            inputRect.top - SUGGESTIONS_GAP - renderedHeight,
          )
        : inputRect.bottom + SUGGESTIONS_GAP;

      setSuggestionsPosition({
        left,
        top,
        width,
        maxHeight: availableHeight,
      });
    }

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [matches.length, showMatches]);

  function commit(nextValue = currentValue) {
    const trimmed = nextValue.trim();
    if (trimmed !== value || error !== undefined) onCommit(trimmed);
    setDraft(null);
    setOpen(false);
    setActiveIndex(-1);
  }

  function choose(suggestion: CustomerSuggestion, input: HTMLInputElement) {
    if (onSelect) {
      onSelect(suggestion);
      setDraft(null);
      setOpen(false);
      setActiveIndex(-1);
    } else {
      commit(suggestion.customerName);
    }
    window.setTimeout(() => focusNextField(input), 0);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" && matches.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => (current + 1 + matches.length) % matches.length);
    } else if (event.key === "ArrowUp" && matches.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) =>
        current <= 0 ? matches.length - 1 : (current - 1) % matches.length,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      const selected = open && activeIndex >= 0 ? matches[activeIndex] : undefined;
      if (selected) choose(selected, event.currentTarget);
      else {
        commit();
        focusNextField(event.currentTarget);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (open) {
        setOpen(false);
        setActiveIndex(-1);
      } else {
        setDraft(null);
        if (error !== undefined) onCommit(value);
      }
    } else if (event.key === "Tab") {
      setOpen(false);
      setActiveIndex(-1);
    }
  }

  function handleOptionMouseDown(
    event: MouseEvent<HTMLButtonElement>,
    suggestion: CustomerSuggestion,
  ) {
    event.preventDefault();
    const input = inputRef.current;
    if (input !== null) choose(suggestion, input);
  }

  return (
    <div className="inline-field-wrap customer-autocomplete">
      <input
        ref={inputRef}
        className={error === undefined ? "inline-field" : "inline-field has-error"}
        value={currentValue}
        aria-label={label}
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : errorId}
        aria-autocomplete="list"
        aria-controls={showMatches ? listId : undefined}
        aria-expanded={showMatches}
        aria-activedescendant={
          showMatches && activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined
        }
        role="combobox"
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete="off"
        onFocus={() => {
          if (normalize(currentValue) !== "") {
            setOpen(true);
            setActiveIndex(matches.length > 0 ? 0 : -1);
          }
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          setOpen(event.target.value.trim() !== "");
          setActiveIndex(event.target.value.trim() !== "" ? 0 : -1);
        }}
        onBlur={() => commit()}
        onKeyDown={handleKeyDown}
      />
      {showMatches &&
        createPortal(
          <ul
            ref={suggestionsRef}
            className="customer-suggestions"
            id={listId}
            role="listbox"
            aria-label="Kundenvorschläge"
            style={
              suggestionsPosition === null
                ? { visibility: "hidden" }
                : {
                    left: `${suggestionsPosition.left}px`,
                    top: `${suggestionsPosition.top}px`,
                    width: `${suggestionsPosition.width}px`,
                    maxHeight: `${suggestionsPosition.maxHeight}px`,
                  }
            }
          >
            {matches.map((suggestion, index) => {
              const context = [suggestion.vehicleName, suggestion.licensePlate]
                .filter(Boolean)
                .join(" · ");
              return (
                <li key={`${suggestion.id}-${suggestion.customerName}`} role="presentation">
                  <button
                    id={`${listId}-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    className={
                      index === activeIndex
                        ? "customer-suggestion is-active"
                        : "customer-suggestion"
                    }
                    onMouseDown={(event) => handleOptionMouseDown(event, suggestion)}
                  >
                    <span>{suggestion.customerName}</span>
                    {context !== "" && <small>{context}</small>}
                  </button>
                </li>
              );
            })}
          </ul>,
          document.body,
        )}
      {error !== undefined && (
        <span className="field-error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
