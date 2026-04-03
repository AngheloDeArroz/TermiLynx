import * as path from 'node:path';
import * as readline from 'node:readline';

const DANGEROUS_PATTERNS: RegExp[] = [
  /rm\s+-rf\s+\//,
  /rm\s+-rf\s+\\/,
  /\bsudo\b/,
  /chmod\s+777/,
  /curl\s+.*\|\s*sh/,
  /curl\s+.*\|\s*bash/,
  /wget\s+.*\|\s*sh/,
  /wget\s+.*\|\s*bash/,
  /mkfs\./,
  /dd\s+if=/,
  /:(){ :\|:& };:/,
  /format\s+[a-zA-Z]:/i,
  /del\s+\/s\s+\/q\s+[a-zA-Z]:\\/i,
  /rd\s+\/s\s+\/q\s+[a-zA-Z]:\\/i,
];

export function confirmAction(description: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(`  ${description} (y/n): `);

    if (process.stdin.isTTY) {
      // Pause any existing listeners, then enter raw mode for a single keypress
      process.stdin.pause();
      process.stdin.setRawMode(true);
      process.stdin.resume();

      const onData = (data: Buffer): void => {
        const char = data.toString().charAt(0).toLowerCase();

        // Ignore non-printable keys (arrows, escape sequences, etc.)
        if (char !== 'y' && char !== 'n') {
          return;
        }

        process.stdin.removeListener('data', onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();

        process.stdout.write(char + '\n');
        resolve(char === 'y');
      };

      process.stdin.on('data', onData);
    } else {
      // Non-TTY fallback (piped input)
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false,
      });
      rl.once('line', (line) => {
        rl.close();
        const normalized = line.trim().toLowerCase();
        resolve(normalized === 'y' || normalized === 'yes');
      });
    }
  });
}

export function isSafePath(targetPath: string, projectRoot: string): boolean {
  const resolved = path.resolve(targetPath);
  const root = path.resolve(projectRoot);

  // Target must be within the project root
  return resolved.startsWith(root + path.sep) || resolved === root;
}

export class DangerousCommandError extends Error {
  constructor(command: string) {
    super(`Blocked dangerous command: ${command}`);
    this.name = 'DangerousCommandError';
  }
}

export function blockDangerousCommand(cmd: string): void {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(cmd)) {
      throw new DangerousCommandError(cmd);
    }
  }
}
