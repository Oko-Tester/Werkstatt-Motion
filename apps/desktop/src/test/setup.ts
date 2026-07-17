import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Ohne Vitest-Globals räumt Testing Library nicht automatisch auf.
afterEach(() => {
  cleanup();
});
