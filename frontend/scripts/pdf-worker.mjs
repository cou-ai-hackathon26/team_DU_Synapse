import { copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
await copyFile(
  require.resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
  "public/pdf.worker.min.mjs",
);
