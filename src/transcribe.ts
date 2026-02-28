import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);

const model = process.env.WHISPER_MODEL ?? "base";

export async function transcribe(wavPath: string): Promise<string> {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-out-"));

  try {
    await execFileAsync(
      "whisper",
      [
        wavPath,
        "--model",
        model,
        "--output_format",
        "txt",
        "--output_dir",
        outDir,
        "--fp16",
        "False",
      ],
      { timeout: 120_000 }
    );

    const baseName = path.basename(wavPath, path.extname(wavPath));
    const txtPath = path.join(outDir, `${baseName}.txt`);

    if (fs.existsSync(txtPath)) {
      return fs.readFileSync(txtPath, "utf-8").trim();
    }

    return "";
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}
