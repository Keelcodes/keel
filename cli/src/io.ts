import { readFile } from 'node:fs/promises';
import process from 'node:process';

/**
 * Everything a command needs from the outside world. Commands depend on this
 * port rather than on `process` and `fs` directly, so tests can run a command
 * end to end with in-memory input and captured output.
 */
export interface CliIo {
  /** Writes one line to standard output. */
  out(line: string): void;
  /** Writes one line to standard error. */
  err(line: string): void;
  /** Reads a text file. */
  readText(path: string): Promise<string>;
  /** Reads standard input to end. */
  readStdin(): Promise<string>;
  /** Environment variables, e.g. `KEEL_RPC_URL`. */
  env: Readonly<Record<string, string | undefined>>;
}

/** The real process: stdout, stderr, the filesystem and the environment. */
export function createNodeIo(): CliIo {
  return {
    out: (line) => {
      process.stdout.write(`${line}\n`);
    },
    err: (line) => {
      process.stderr.write(`${line}\n`);
    },
    readText: (path) => readFile(path, 'utf8'),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
      return Buffer.concat(chunks).toString('utf8');
    },
    env: process.env,
  };
}

/** Reads `path`, or standard input when `path` is `-`. */
export async function readInput(io: CliIo, path: string): Promise<string> {
  return path === '-' ? io.readStdin() : io.readText(path);
}
