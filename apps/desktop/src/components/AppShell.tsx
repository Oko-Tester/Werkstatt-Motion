import type { ReactNode } from "react";

interface AppShellProps {
  header: ReactNode;
  children: ReactNode;
}

export function AppShell({ header, children }: AppShellProps) {
  return (
    <div className="app-shell">
      {header}
      <main className="app-main">{children}</main>
    </div>
  );
}
