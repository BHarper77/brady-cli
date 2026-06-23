import * as p from "@clack/prompts";
import { execSync } from "child_process";

/** Run a command in PowerShell, optionally from a given working directory. */
export function exec(command: string, cwd?: string) {
  return execSync(command, {
    cwd,
    shell: "powershell.exe",
  });
}

/**
 * Unwrap a clack prompt result, exiting cleanly on cancel. Collapses the
 * repeated `if (p.isCancel(x)) { p.cancel(...); process.exit(0) }` dance.
 */
export function promptOrExit<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }
  return value;
}
