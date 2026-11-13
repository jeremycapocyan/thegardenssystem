import { readFile } from "node:fs/promises";
import path from "node:path";
export async function loadTimesheetPdfAssets() {
  const root = process.cwd();
  const [regular, bold, crest, wordmark] = await Promise.all([
    readFile(path.join(root, "public/fonts/NotoSerif-Regular.ttf")),
    readFile(path.join(root, "public/fonts/NotoSerif-Bold.ttf")),
    readFile(path.join(root, "public/brand/gardens-crest.jpg")),
    readFile(path.join(root, "public/brand/gardens-wordmark.png")),
  ]);
  return { regular, bold, crest, wordmark };
}
