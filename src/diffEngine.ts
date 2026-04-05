import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { createPatch } from 'diff';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FileDiff {
  filePath: string;
  patch: string;       // unified diff (--- old, +++ new, @@ hunks with 3 lines context)
  original: string;
  modified: string;
}

// ─── Diff Generation ────────────────────────────────────────────────────────

/**
 * Generate a unified diff for a single file.
 * Uses 3 lines of context around each hunk (standard unified diff).
 */
export function generateDiff(
  filePath: string,
  original: string,
  modified: string,
): FileDiff {
  const patch = createPatch(
    filePath,
    original,
    modified,
    'original',
    'modified',
    { context: 3 },
  );

  return { filePath, patch, original, modified };
}

// ─── Grouping ───────────────────────────────────────────────────────────────

/**
 * Group an array of FileDiffs by file path.
 * Multiple workers may produce diffs for the same file — this groups them
 * so the orchestrator can detect conflicts and present them together.
 */
export function groupDiffsByFile(diffs: FileDiff[]): Map<string, FileDiff[]> {
  const grouped = new Map<string, FileDiff[]>();

  for (const diff of diffs) {
    const existing = grouped.get(diff.filePath);
    if (existing) {
      existing.push(diff);
    } else {
      grouped.set(diff.filePath, [diff]);
    }
  }

  return grouped;
}

// ─── Apply ──────────────────────────────────────────────────────────────────

/**
 * Write approved diffs to disk using atomic rename.
 * Takes the `modified` content from each FileDiff, NOT the patch text.
 */
export function applyDiffs(diffs: FileDiff[], projectRoot: string): string[] {
  const written: string[] = [];

  for (const diff of diffs) {
    const absolutePath = path.resolve(projectRoot, diff.filePath);
    const dir = path.dirname(absolutePath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Atomic write: write to tmp then rename
    const tempPath = absolutePath + '.tmp';
    fs.writeFileSync(tempPath, diff.modified, 'utf-8');
    fs.renameSync(tempPath, absolutePath);
    written.push(diff.filePath);
  }

  return written;
}

// ─── VS Code Diff Integration ──────────────────────────────────────────────

/**
 * Check if we're running inside VS Code's integrated terminal.
 */
export function isInsideVSCodeTerminal(): boolean {
  return !!process.env.VSCODE_IPC_HOOK_CLI || process.env.TERM_PROGRAM === 'vscode';
}

/**
 * Open VS Code's built-in diff viewer for a FileDiff.
 * Creates temp files for original/proposed and opens `code --diff`.
 * Returns a cleanup function to remove temp files.
 */
export function openVSCodeDiffPreview(
  diff: FileDiff,
  projectRoot: string,
): { cleanup: () => void } {
  const absolutePath = path.resolve(projectRoot, diff.filePath);
  const dir = path.dirname(absolutePath);
  const baseName = path.basename(absolutePath);
  const proposedPath = path.join(dir, `.openmerlin-proposed-${baseName}`);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // For new files, create an empty original so diff works
  let createdOriginal = false;
  if (!fs.existsSync(absolutePath)) {
    fs.writeFileSync(absolutePath, '', 'utf-8');
    createdOriginal = true;
  }

  // Write proposed content
  fs.writeFileSync(proposedPath, diff.modified, 'utf-8');

  // Open VS Code diff
  try {
    execSync(`code -r --diff "${absolutePath}" "${proposedPath}"`, { stdio: 'ignore' });
  } catch {
    // VS Code command failed — caller should fall back to terminal diff
  }

  return {
    cleanup: () => {
      try { fs.unlinkSync(proposedPath); } catch { /* ignore */ }
      if (createdOriginal) {
        try { fs.unlinkSync(absolutePath); } catch { /* ignore */ }
      }
    },
  };
}

