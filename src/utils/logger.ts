// WIP
import { LOG_PREFIX } from "../constants.js";
import { createHash } from "crypto";

export class Logger {
  private static formatMessage(message: string): string {
    return `${LOG_PREFIX} ${message}` + "\n";
  }

  private static shouldLogPrompts(): boolean {
    return process.env.GEMINI_MCP_LOG_PROMPTS === "1";
  }

  private static redactString(value: string): string {
    if (this.shouldLogPrompts()) return value;
    const hash = createHash("sha256").update(value).digest("hex").slice(0, 12);
    return `[REDACTED len=${value.length} sha256=${hash}]`;
  }

  private static sanitizeArgs(args: unknown): unknown {
    if (this.shouldLogPrompts()) return args;
    if (!args || typeof args !== "object") return args;

    if (Array.isArray(args)) {
      return args.map((v) => (typeof v === "string" ? this.redactString(v) : v));
    }

    const copy: Record<string, unknown> = { ...(args as any) };
    for (const key of Object.keys(copy)) {
      if (key.toLowerCase().includes("prompt") && typeof copy[key] === "string") {
        copy[key] = this.redactString(copy[key] as string);
      }
    }
    return copy;
  }

  static log(message: string, ...args: any[]): void {
    console.warn(this.formatMessage(message), ...args);
  }

  static warn(message: string, ...args: any[]): void {
    console.warn(this.formatMessage(message), ...args);
  }

  static error(message: string, ...args: any[]): void {
    console.error(this.formatMessage(message), ...args);
  }

  static debug(message: string, ...args: any[]): void {
    console.warn(this.formatMessage(message), ...args);
  }

  static toolInvocation(toolName: string, args: any): void {
    const safeArgs = this.sanitizeArgs(args);
    this.warn("Raw:", JSON.stringify(safeArgs, null, 2));
  }

  static toolParsedArgs(prompt: string, model?: string, sandbox?: boolean, changeMode?: boolean): void {
    const safePrompt = this.redactString(prompt);
    this.warn(`Parsed prompt: "${safePrompt}"\nchangeMode: ${changeMode || false}`);
  }

  static commandExecution(command: string, args: string[], startTime: number): void {
    const safeArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const prev = args[i - 1];
      const current = args[i];
      const shouldRedact = !this.shouldLogPrompts() && (prev === "-p" || prev === "--prompt");
      safeArgs.push(shouldRedact ? this.redactString(current) : current);
    }
    this.warn(`[${startTime}] Starting: ${command} ${safeArgs.map((arg) => `"${arg}"`).join(" ")}`);
    
    // Store command execution start for timing analysis
    this._commandStartTimes.set(startTime, { command, args: safeArgs, startTime });
  }

  // Track command start times for duration calculation
  private static _commandStartTimes = new Map<number, { command: string; args: string[]; startTime: number }>();

  static commandComplete(startTime: number, exitCode: number | null, outputLength?: number): void {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    this.warn(`[${elapsed}s] Process finished with exit code: ${exitCode}`);
    if (outputLength !== undefined) {
      this.warn(`Response: ${outputLength} chars`);
    }

    // Clean up command tracking
    this._commandStartTimes.delete(startTime);
  }
}
