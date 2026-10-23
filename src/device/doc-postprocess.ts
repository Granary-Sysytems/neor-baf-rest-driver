import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "../errors.js";
import type { CaptureFormat } from "./ffmpeg-adapter.js";

const here = dirname(fileURLToPath(import.meta.url));
const defaultScript = join(here, "../../scripts/doc_crop.py");

export type PostprocessOptions = {
  autoCrop: boolean;
  deskew: boolean;
  format: CaptureFormat;
  pythonPath?: string;
  scriptPath?: string;
};

export type PostprocessResult = {
  buffer: Buffer;
  width: number;
  height: number;
  applied: boolean;
  method: string;
  sourceWidth: number;
  sourceHeight: number;
};

function runPython(
  pythonPath: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, args, {
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new AppError(504, "POSTPROCESS_TIMEOUT", "Document post-process timed out"),
      );
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export async function postprocessDocument(
  input: Buffer,
  opts: PostprocessOptions,
): Promise<PostprocessResult> {
  if (!opts.autoCrop && !opts.deskew) {
    throw new AppError(400, "INVALID_POSTPROCESS", "autoCrop or deskew must be true");
  }

  const pythonPath =
    opts.pythonPath ??
    process.env.DOC_CROP_PYTHON ??
    join(here, "../../.venv/bin/python");
  const scriptPath = opts.scriptPath ?? process.env.DOC_CROP_SCRIPT ?? defaultScript;
  const ext = opts.format === "png" ? "png" : "jpg";
  const dir = await mkdtemp(join(tmpdir(), "neor-doc-"));
  const inPath = join(dir, `in.${ext}`);
  const outPath = join(dir, `out.${ext}`);

  try {
    await writeFile(inPath, input);
    const args = [
      scriptPath,
      "--input",
      inPath,
      "--output",
      outPath,
    ];
    if (opts.autoCrop) args.push("--auto-crop");
    if (opts.deskew) args.push("--deskew");

    const result = await runPython(pythonPath, args, 45_000);
    if (result.code !== 0) {
      throw new AppError(
        500,
        "POSTPROCESS_FAILED",
        `doc_crop.py failed: ${result.stderr || result.stdout || `exit ${result.code}`}`,
      );
    }

    let meta: {
      ok?: boolean;
      applied?: boolean;
      method?: string;
      width?: number;
      height?: number;
      sourceWidth?: number;
      sourceHeight?: number;
      error?: string;
    };
    try {
      meta = JSON.parse(result.stdout.trim().split(/\r?\n/).pop() ?? "{}");
    } catch {
      throw new AppError(
        500,
        "POSTPROCESS_FAILED",
        `Invalid doc_crop.py output: ${result.stdout}`,
      );
    }
    if (!meta.ok) {
      throw new AppError(
        500,
        "POSTPROCESS_FAILED",
        meta.error ?? "doc_crop.py reported failure",
      );
    }

    const buffer = await readFile(outPath);
    return {
      buffer,
      width: meta.width ?? 0,
      height: meta.height ?? 0,
      applied: Boolean(meta.applied),
      method: meta.method ?? "unknown",
      sourceWidth: meta.sourceWidth ?? 0,
      sourceHeight: meta.sourceHeight ?? 0,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (/ENOENT|not found/i.test(message)) {
      throw new AppError(
        500,
        "POSTPROCESS_UNAVAILABLE",
        "Python/OpenCV post-process unavailable. Create .venv and pip install -r requirements.txt",
      );
    }
    throw new AppError(500, "POSTPROCESS_FAILED", message);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
