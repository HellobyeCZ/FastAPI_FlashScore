"use client";
import Link from "next/link";
import { clsx } from "clsx";
import { ModelName } from "@/components/ui";
import { useLocale } from "@/contexts/LocaleContext";
import { routes } from "@/lib/routes";

/**
 * Model name (with its colour swatch) linking to the model page. ModelName
 * truncates its label; `wrap` lets a long name break across lines instead,
 * for narrow table cells on phones where the cell would otherwise widen the
 * table past the screen.
 */
export function ModelLink({ model, className, wrap = false }: { model: string; className?: string; wrap?: boolean }) {
  const { locale } = useLocale();
  return (
    <Link
      href={routes.model(locale, model)}
      className={clsx(
        "hover:text-accent focus-visible:text-accent",
        wrap && "[&_.truncate]:whitespace-normal",
        className
      )}
    >
      <ModelName name={model} />
    </Link>
  );
}
