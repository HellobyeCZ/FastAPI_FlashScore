import type { en } from "../en";
import { common } from "./common";
import { shell } from "./shell";
import { today } from "./today";
import { matches } from "./matches";
import { performance } from "./performance";
import { lab } from "./lab";
import { ops } from "./ops";
import { settings } from "./settings";
import { charts } from "./charts";

// Typed against the English catalog: a missing Czech key fails `tsc`.
export const cs: Record<keyof typeof en, string> = {
  ...common,
  ...shell,
  ...today,
  ...matches,
  ...performance,
  ...lab,
  ...ops,
  ...settings,
  ...charts
};
