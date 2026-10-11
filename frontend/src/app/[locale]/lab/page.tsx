import { redirect } from "next/navigation";

export default function LabIndex({ params }: { params: { locale: string } }) {
  redirect(`/${params.locale}/lab/backtests`);
}
