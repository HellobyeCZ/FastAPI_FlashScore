"use client";
import Link from "next/link";
import { clsx } from "clsx";
import { ModelName } from "@/components/ui";
import { useLocale } from "@/contexts/LocaleContext";
import { routes } from "@/lib/routes";

/** Model name (with its colour swatch) linking to the model page. */
export function ModelLink({ model, className }: { model: string; className?: string }) {
  const { locale } = useLocale();
  return (
    <Link href={routes.model(locale, model)} className={clsx("hover:text-accent focus-visible:text-accent", className)}>
      <ModelName name={model} />
    </Link>
  );
}
