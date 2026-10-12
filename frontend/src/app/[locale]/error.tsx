"use client";
import { useEffect } from "react";
import { useLocale } from "@/contexts/LocaleContext";
import { Button, Callout, PageHeader } from "@/components/ui";

// Render errors stay inside the shell instead of white-screening the app.
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useLocale();
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <>
      <PageHeader title={t("common.error")} />
      <Callout
        tone="neg"
        urgent
        title={t("common.error")}
        action={
          <Button size="sm" onClick={reset}>
            {t("common.retry")}
          </Button>
        }
      >
        <code className="break-all">{error.message}</code>
      </Callout>
    </>
  );
}
