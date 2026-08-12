import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type Unsubscribe = () => void;

export interface AppServerTransport {
  start(): Promise<void>;
  writeLine(line: string): Promise<void>;
  stop(): Promise<void>;
  onLine(listener: (line: string) => void): Unsubscribe;
  onStderr(listener: (text: string) => void): Unsubscribe;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): Unsubscribe;
}

export interface ProcessTransportOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export class ProcessAppServerTransport implements AppServerTransport {
  readonly #options: ProcessTransportOptions;
  readonly #lineListeners = new Set<(line: string) => void>();
  readonly #stderrListeners = new Set<(text: string) => void>();
  readonly #exitListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
  #child: ChildProcessWithoutNullStreams | undefined;

  constructor(options: ProcessTransportOptions = {}) {
    this.#options = options;
  }

  async start(): Promise<void> {
    if (this.#child !== undefined) {
      throw new Error("Codex App Server 子进程已经启动");
    }

    const child = spawn(this.#options.command ?? "codex", this.#options.args ?? ["app-server", "--listen", "stdio://"], {
      cwd: this.#options.cwd,
      env: this.#options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      for (const listener of this.#lineListeners) listener(line);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const listener of this.#stderrListeners) listener(chunk);
    });
    child.once("exit", (code, signal) => {
      lines.close();
      this.#child = undefined;
      for (const listener of this.#exitListeners) listener(code, signal);
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }

  async writeLine(line: string): Promise<void> {
    const child = this.#child;
    if (child === undefined || !child.stdin.writable) {
      throw new Error("Codex App Server 标准输入不可写");
    }
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(`${line}\n`, "utf8", (error) => {
        if (error === null || error === undefined) resolve();
        else reject(error);
      });
    });
  }

  stop(): Promise<void> {
    const child = this.#child;
    if (child === undefined) return Promise.resolve();
    child.stdin.end();
    child.kill("SIGTERM");
    return Promise.resolve();
  }

  onLine(listener: (line: string) => void): Unsubscribe {
    this.#lineListeners.add(listener);
    return () => this.#lineListeners.delete(listener);
  }

  onStderr(listener: (text: string) => void): Unsubscribe {
    this.#stderrListeners.add(listener);
    return () => this.#stderrListeners.delete(listener);
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): Unsubscribe {
    this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }
}
