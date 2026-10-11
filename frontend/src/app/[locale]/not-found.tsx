"use client";
import { useLocale } from "@/contexts/LocaleContext";
import { ButtonLink, EmptyState } from "@/components/ui";
import { routes } from "@/lib/routes";

export default function NotFound() {
  const { t, locale } = useLocale();
  return (
    <EmptyState
      title="404"
      action={
        <ButtonLink href={routes.today(locale)} variant="primary">
          {t("nav.today")}
        </ButtonLink>
      }
    />
  );
}
