import type { ReactNode } from "react";

interface PrimaryButtonProps {
  onClick: () => void;
  children: ReactNode;
}

export function PrimaryButton({ onClick, children }: PrimaryButtonProps) {
  return (
    <button type="button" className="btn btn-primary" onClick={onClick}>
      {children}
    </button>
  );
}
