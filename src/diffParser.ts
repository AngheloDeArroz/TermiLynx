import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];  // each line prefixed with ' ', '+', or '-'
}

export interface ParsedFileDiff {
  filePath: string;       // relative path (e.g. "src/app/Footer.tsx")
  isNewFile: boolean;
  isDeletedFile: boolean;
  hunks: DiffHunk[];
}

// ─── Parse Diff ─────────────────────────────────────────────────────────────

/**
 * Extract all unified diff blocks from an LLM response string.
 * Handles:
 *   - Standard unified diff (--- a/path ... +++ b/path ... @@ hunks)
 *   - Diffs wrapped in ```diff fenced code blocks
 *   - New files (--- /dev/null) and deleted files (+++ /dev/null)
 */
export function parseDiff(response: string): ParsedFileDiff[] {
  // Strip fenced code block wrappers if present
  // Replace ```diff\n...\n``` with just the inner content
  let cleaned = response.replace(/```diff\s*\n([\s\S]*?)```/g, '$1');
  // Also handle generic code blocks that contain diffs
  cleaned = cleaned.replace(/```\s*\n(---[\s\S]*?)```/g, '$1');

  const lines = cleaned.split('\n');
  const diffs: ParsedFileDiff[] = [];

  let i = 0;
  while (i < lines.length) {
    // Look for --- line
    if (!lines[i].startsWith('--- ')) {
      i++;
      continue;
    }

    const minusLine = lines[i];
    i++;

    // Next line must be +++ 
    if (i >= lines.length || !lines[i].startsWith('+++ ')) {
      continue;
    }

    const plusLine = lines[i];
    i++;

    // Extract file paths
    const oldPath = extractPath(minusLine.slice(4));
    const newPath = extractPath(plusLine.slice(4));

    const isNewFile = oldPath === '/dev/null';
    const isDeletedFile = newPath === '/dev/null';
    const filePath = isNewFile ? newPath : oldPath;

    // Parse hunks
    const hunks: DiffHunk[] = [];

    while (i < lines.length && lines[i].startsWith('@@')) {
      const hunkHeader = lines[i];
      const match = hunkHeader.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);

      if (!match) {
        i++;
        continue;
      }

      const hunk: DiffHunk = {
        oldStart: parseInt(match[1], 10),
        oldCount: match[2] !== undefined ? parseInt(match[2], 10) : 1,
        newStart: parseInt(match[3], 10),
        newCount: match[4] !== undefined ? parseInt(match[4], 10) : 1,
        lines: [],
      };

      i++; // skip @@ line

      // Collect hunk body lines
      while (i < lines.length) {
        const line = lines[i];
        if (
          line.startsWith(' ') ||
          line.startsWith('+') ||
          line.startsWith('-')
        ) {
          // Don't capture --- or +++ as hunk lines
          if (line.startsWith('--- ') || line.startsWith('+++ ')) break;
          hunk.lines.push(line);
          i++;
        } else if (line === '' || line.startsWith('\\')) {
          // "\ No newline at end of file" or empty context
          i++;
        } else {
          break;
        }
      }

      hunks.push(hunk);
    }

    if (hunks.length > 0) {
      diffs.push({ filePath, isNewFile, isDeletedFile, hunks });
    }
  }

  return diffs;
}

/**
 * Strip a/b prefix and any trailing tabs/timestamps from diff path.
 * e.g. "a/src/foo.ts" → "src/foo.ts"
 *      "b/src/foo.ts\t2025-01-01" → "src/foo.ts"
 */
function extractPath(raw: string): string {
  let p = raw.trim();
  // Remove trailing tab and everything after (timestamps)
  const tabIdx = p.indexOf('\t');
  if (tabIdx !== -1) p = p.slice(0, tabIdx);
  // Strip a/ or b/ prefix
  if (p.startsWith('a/') || p.startsWith('b/')) {
    p = p.slice(2);
  }
  return p;
}

// ─── Apply Parsed Diffs ─────────────────────────────────────────────────────

/**
 * Apply parsed diffs to disk using pure file I/O — no AI involved.
 * Uses atomic write pattern (write .tmp → rename).
 * Returns list of written file paths.
 */
export function applyParsedDiffs(
  diffs: ParsedFileDiff[],
  projectRoot: string,
): string[] {
  const written: string[] = [];

  for (const diff of diffs) {
    const absolutePath = path.resolve(projectRoot, diff.filePath);
    const dir = path.dirname(absolutePath);

    // Handle deletions
    if (diff.isDeletedFile) {
      try {
        fs.unlinkSync(absolutePath);
        written.push(diff.filePath);
      } catch { /* file may not exist */ }
      continue;
    }

    // Ensure directory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Read original content (empty for new files)
    let originalLines: string[] = [];
    if (!diff.isNewFile && fs.existsSync(absolutePath)) {
      originalLines = fs.readFileSync(absolutePath, 'utf-8').split('\n');
    }

    // Apply hunks
    const result = applyHunks(originalLines, diff.hunks);

    // Atomic write
    const tempPath = absolutePath + '.tmp';
    fs.writeFileSync(tempPath, result.join('\n'), 'utf-8');
    fs.renameSync(tempPath, absolutePath);
    written.push(diff.filePath);
  }

  return written;
}

/**
 * Apply hunks to an array of lines, producing the new content.
 * Processes hunks in reverse order to avoid line-number shifts.
 */
function applyHunks(originalLines: string[], hunks: DiffHunk[]): string[] {
  const result = [...originalLines];

  // Sort hunks by oldStart descending so later hunks don't shift earlier ones
  const sorted = [...hunks].sort((a, b) => b.oldStart - a.oldStart);

  for (const hunk of sorted) {
    const newLines: string[] = [];
    for (const line of hunk.lines) {
      if (line.startsWith('+')) {
        newLines.push(line.slice(1));
      } else if (line.startsWith('-')) {
        // removed — skip
      } else if (line.startsWith(' ')) {
        newLines.push(line.slice(1));
      }
    }

    // Replace the old range with new content
    // oldStart is 1-indexed; array is 0-indexed
    const startIdx = hunk.oldStart - 1;
    result.splice(startIdx, hunk.oldCount, ...newLines);
  }

  return result;
}

// ─── Reconstruct Full File Content ──────────────────────────────────────────

/**
 * Given a parsed diff, reconstruct what the new file content should be.
 * Useful for opening a VS Code diff preview before applying.
 */
export function reconstructFile(
  diff: ParsedFileDiff,
  projectRoot: string,
): string {
  const absolutePath = path.resolve(projectRoot, diff.filePath);

  let originalLines: string[] = [];
  if (!diff.isNewFile && fs.existsSync(absolutePath)) {
    originalLines = fs.readFileSync(absolutePath, 'utf-8').split('\n');
  }

  const result = applyHunks(originalLines, diff.hunks);
  return result.join('\n');
}
