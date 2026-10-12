import { common } from "./common";
import { shell } from "./shell";
import { today } from "./today";
import { matches } from "./matches";
import { performance } from "./performance";
import { lab } from "./lab";
import { ops } from "./ops";
import { settings } from "./settings";
import { charts } from "./charts";

export const en = {
  ...common,
  ...shell,
  ...today,
  ...matches,
  ...performance,
  ...lab,
  ...ops,
  ...settings,
  ...charts
} as const;
