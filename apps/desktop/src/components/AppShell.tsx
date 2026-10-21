import type { ReactNode } from "react";

interface AppShellProps {
  nav: ReactNode;
  header: ReactNode;
  children: ReactNode;
}

export function AppShell({ nav, header, children }: AppShellProps) {
  return (
    <div className="app-shell">
      {nav}
      <div className="app-content">
        {header}
        <main className="app-main">{children}</main>
      </div>
    </div>
  );
}
