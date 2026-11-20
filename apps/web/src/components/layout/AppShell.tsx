import type { ReactNode } from 'react';

interface AppShellProps {
  children: ReactNode;
  variant?: 'arena' | 'light';
}

export function AppShell({ children, variant = 'arena' }: AppShellProps) {
  return (
    <div className={`min-h-[100dvh] ${variant === 'arena' ? 'arena-bg' : 'bg-background'}`}>
      {children}
    </div>
  );
}