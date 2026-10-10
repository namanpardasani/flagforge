import { Link } from "react-router";
import { cn } from "@/lib/cn";

// The union type (adapted from Watermelon UI's "breadcrumb-1") makes wrong data impossible to
// write: a segment is either a link with an href, or the current page without one. Never both.
export type Crumb = { label: string; to: string; current?: false; mono?: boolean } | { label: string; current: true; to?: never; mono?: boolean };

export function Breadcrumbs({ items, className }: { items: readonly Crumb[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={cn("min-w-0", className)}>
      <ol className="flex min-w-0 items-center gap-2 text-sm">
        {items.map((item, index) => (
          <li key={`${index}-${item.label}`} className="flex min-w-0 items-center gap-2">
            {index > 0 && (
              <span aria-hidden className="font-mono text-faint">
                /
              </span>
            )}
            {item.current ? (
              <span aria-current="page" className={cn("truncate text-ink", item.mono && "font-mono text-xs")}>
                {item.label}
              </span>
            ) : (
              <Link to={item.to} className={cn("truncate text-muted hover:text-ink", item.mono && "font-mono text-xs")}>
                {item.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
