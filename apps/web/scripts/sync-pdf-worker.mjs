/**
 * 把 pdf.js 的 worker 复制到 public/，由我们自己托管。
 *
 * 不用 `import(...?url)` 那类打包器魔法：实测在非 Vite 的打包路径下会拿到
 * 非字符串，pdf.js 直接抛 "Invalid workerSrc type"，而且要等到运行时才暴露。
 * public/ 在 dev 与 build 下行为一致，路径就是路径，没有中间层。
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const src = path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "build/pdf.worker.min.mjs");
const destDir = new URL("../public/pdfjs/", import.meta.url).pathname;
mkdirSync(destDir, { recursive: true });
copyFileSync(src, path.join(destDir, "pdf.worker.min.mjs"));
console.log("pdf.js worker →", path.join(destDir, "pdf.worker.min.mjs"));
