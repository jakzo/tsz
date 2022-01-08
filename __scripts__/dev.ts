import fs from "fs/promises";
import path from "path";

import { compileAndLog } from "../src";

const main = async (): Promise<void> => {
  const code = await fs.readFile(path.resolve(process.argv[2]), "utf8");
  const result = compileAndLog(code);
  console.log(result);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
