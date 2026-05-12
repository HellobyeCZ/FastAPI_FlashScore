import { Kicker } from "./Kicker";
import { Glyph } from "./Glyph";

export function PageHeader({
  kicker,
  actions
}: {
  kicker: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex h-10 items-center justify-between border-b border-border">
      <div className="flex items-center gap-2">
        <Glyph kind="section" className="text-accent" />
        <Kicker>{kicker}</Kicker>
      </div>
      {actions && <div className="flex items-center gap-3">{actions}</div>}
    </div>
  );
}
