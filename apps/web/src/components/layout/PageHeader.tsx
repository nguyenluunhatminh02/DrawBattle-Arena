import Link from 'next/link';
import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  backHref?: string;
}

export function PageHeader({ title, subtitle, actions, backHref }: PageHeaderProps) {
  return (
    <header className="sticky top-0 z-40 safe-top arena-bg border-b border-panel-border/30">
      <div className="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {backHref && (
            <Link
              href={backHref}
              className="text-on-arena hover:text-accent-on-arena transition-colors text-sm font-medium shrink-0"
              aria-label="Quay lại"
            >
              ← Về
            </Link>
          )}
          <div className="min-w-0">
            <h1 className="text-lg md:text-xl font-bold text-on-arena truncate">{title}</h1>
            {subtitle && (
              <p className="text-xs text-muted-on-arena truncate">{subtitle}</p>
            )}
          </div>
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
    </header>
  );
}