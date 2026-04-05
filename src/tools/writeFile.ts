import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { isSafePath, confirmAction } from '../safety.js';
import { isInsideVSCodeTerminal } from '../diffEngine.js';
import * as output from '../output.js';
import type { Tool, ToolResult } from './index.js';

/**
 * Open VS Code's built-in diff viewer in the existing window.
 */
function openVSCodeDiff(originalPath: string, modifiedPath: string): void {
  execSync(`code -r --diff "${originalPath}" "${modifiedPath}"`, { stdio: 'ignore' });
}

export const writeFileTool: Tool = {
  definition: {
    name: 'write_file',
    description: 'Write content to a file. Shows a diff and asks for user confirmation before writing. Path should be relative to the project root.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The file path relative to the project root',
        },
        content: {
          type: 'string',
          description: 'The full content to write to the file',
        },
      },
      required: ['path', 'content'],
    },
  },

  async execute(params: Record<string, unknown>, projectRoot: string): Promise<ToolResult> {
    const filePath = params.path as string;
    const newContent = params.content as string;
    const absolutePath = path.resolve(projectRoot, filePath);

    if (!isSafePath(absolutePath, projectRoot)) {
      return {
        success: false,
        output: '',
        error: `Access denied: ${filePath} is outside the project directory`,
      };
    }

    // Read existing content for diff
    let existingContent = '';
    const isNewFile = !fs.existsSync(absolutePath);
    if (!isNewFile) {
      try {
        existingContent = fs.readFileSync(absolutePath, 'utf-8');
      } catch {
        // File exists but can't read — treat as new file
      }
    }

    // Check if content is identical
    if (existingContent === newContent) {
      return { success: true, output: `File unchanged: ${filePath}` };
    }

    // --- VS Code diff (only inside VS Code's integrated terminal) ---
    if (isInsideVSCodeTerminal()) {
      const dir = path.dirname(absolutePath);
      const baseName = path.basename(absolutePath);
      const proposedPath = path.join(dir, `.openmerlin-proposed-${baseName}`);

      // For new files, create an empty original so diff works
      let createdOriginal = false;
      if (isNewFile) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(absolutePath, '', 'utf-8');
        createdOriginal = true;
      }

      fs.writeFileSync(proposedPath, newContent, 'utf-8');

      try {
        openVSCodeDiff(absolutePath, proposedPath);
        output.vscodeDiffOpened(filePath);
      } catch {
        // VS Code diff failed, show terminal diff
        output.showDiff(filePath, existingContent, newContent);
      }

      const confirmed = await confirmAction('Accept changes?');

      // Cleanup
      try { fs.unlinkSync(proposedPath); } catch { /* ignore */ }
      if (!confirmed && createdOriginal) {
        try { fs.unlinkSync(absolutePath); } catch { /* ignore */ }
      }

      if (!confirmed) {
        return { success: false, output: '', error: 'User rejected the changes' };
      }
    } else {
      // --- Terminal diff (external terminal) ---
      output.showDiff(filePath, existingContent, newContent);

      const confirmed = await confirmAction('Write changes?');
      if (!confirmed) {
        return { success: false, output: '', error: 'User cancelled the write operation' };
      }
    }

    // Write the file
    try {
      const dir = path.dirname(absolutePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const tempPath = absolutePath + '.tmp';
      fs.writeFileSync(tempPath, newContent, 'utf-8');
      fs.renameSync(tempPath, absolutePath);

      return { success: true, output: `File written: ${filePath}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: '', error: message };
    }
  },
};
