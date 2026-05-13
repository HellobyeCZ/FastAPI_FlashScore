import { redirect } from "next/navigation";
import { defaultLocale } from "@/lib/i18n";

export default function RootIndex() {
  redirect(`/${defaultLocale}/today`);
}
