import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import type { Config } from './config.js';
import { callLLM, LLMError } from './llm.js';
import type { LLMMessage, ToolCall } from './llm.js';
import { getReadOnlyToolDefinitions, executeTool } from './tools/index.js';
import { compactToolResults, pruneHistory, estimateHistoryTokens } from './historyManager.js';
import { parseDiff, applyParsedDiffs, reconstructFile } from './diffParser.js';
import type { ParsedFileDiff } from './diffParser.js';
import { confirmAction } from './safety.js';
import * as output from './output.js';

const MAX_TOOL_ITERATIONS = 20;
const DIFF_COMPLETE_MARKER = 'DIFF_COMPLETE';

// ─── System Prompt ──────────────────────────────────────────────────────────

function buildPlanAgentPrompt(projectContext: string): string {
  return `You are OpenMerlin-CLI, an expert coding assistant running in the user's terminal.

## Project Context
${projectContext}

## Rules
- You can READ files using tools (read_file, list_files, search_code) to understand the codebase.
- You must NEVER write files directly. Instead, express ALL changes as a unified diff.
- Think step-by-step. Read the files you need first, then produce your diff.
- Never modify files outside the project directory.
- Never expose API keys or secrets.

## Output Format
After reading files and reasoning about the changes, output a unified diff block for EVERY file you want to change:

\`\`\`diff
--- a/path/to/file.ts
+++ b/path/to/file.ts
@@ -startline,count +startline,count @@
 context line
-removed line
+added line
 context line
\`\`\`

For NEW files use \`--- /dev/null\` as the old path.
For DELETED files use \`+++ /dev/null\` as the new path.
Include 3 lines of context around each change.

When you are done producing all diffs, end your response with the exact marker:
${DIFF_COMPLETE_MARKER}`;
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

export async function runAgent(
  userInput: string,
  history: LLMMessage[],
  config: Config,
  projectContext: string,
  projectRoot: string,
): Promise<void> {
  // Build system prompt if first message
  if (history.length === 0) {
    history.push({
      role: 'system',
      content: buildPlanAgentPrompt(projectContext),
    });
  }

  // Append user message
  history.push({ role: 'user', content: userInput });

  // ═══════════════════════════════════════════════════════════════════════════
  //  PHASE 1 — Plan Agent (AI reads files, reasons, outputs unified diff)
  // ═══════════════════════════════════════════════════════════════════════════

  output.phaseLabel('Phase 1: Planning...');

  const readOnlyTools = getReadOnlyToolDefinitions();
  let iterations = 0;
  let finalResponse = '';

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;

    // Token optimization
    compactToolResults(history, 2);
    const prunedHistory = pruneHistory(history);
    const inputTokens = estimateHistoryTokens(prunedHistory);
    output.tokenEstimate(inputTokens);

    let response;
    try {
      response = await callLLM(config, prunedHistory, readOnlyTools);
    } catch (err) {
      if (err instanceof LLMError) {
        output.error(`LLM API error: ${err.message}`);
      } else {
        output.error(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // If there are tool calls (read-only), execute them
    if (response.toolCalls && response.toolCalls.length > 0) {
      history.push({
        role: 'assistant',
        content: response.content || '',
      });

      // Patch tool_calls onto the message for API compatibility
      const lastMsg = history[history.length - 1] as LLMMessage & { tool_calls?: object[] };
      lastMsg.tool_calls = response.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      }));

      // Execute each read-only tool call
      for (const toolCall of response.toolCalls) {
        output.toolStart(`${toolCall.name} → ${formatToolArgs(toolCall.arguments)}`);

        const result = await executeTool(toolCall.name, toolCall.arguments, projectRoot);

        if (result.success) {
          output.toolDone(toolCall.name);
        } else {
          output.error(result.error || 'Tool execution failed');
        }

        history.push({
          role: 'tool',
          content: result.success
            ? result.output
            : `Error: ${result.error || 'Unknown error'}`,
          tool_call_id: toolCall.id,
        });
      }

      continue; // Loop back to get AI's next response
    }

    // No tool calls — this is the final response
    if (response.content) {
      finalResponse = response.content;
      history.push({ role: 'assistant', content: response.content });
    }
    break;
  }

  if (iterations >= MAX_TOOL_ITERATIONS) {
    output.warn(`Reached maximum tool iterations (${MAX_TOOL_ITERATIONS}). Stopping.`);
  }

  if (!finalResponse) {
    output.error('No response from AI.');
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PHASE 2 — Apply (no AI — pure TypeScript parse + write)
  // ═══════════════════════════════════════════════════════════════════════════

  // Check if response contains diffs
  const parsedDiffs = parseDiff(finalResponse);

  if (parsedDiffs.length === 0) {
    // No diffs — just a conversational reply (questions, explanations, etc.)
    output.agentReply(finalResponse);
    return;
  }

  output.phaseLabel('Phase 2: Applying changes...');
  output.diffSummary(parsedDiffs.map((d) => d.filePath));

  // Open diffs in VS Code if available
  const useVSCode = isInsideVSCodeTerminal();

  if (useVSCode) {
    const cleanups = openAllDiffsInVSCode(parsedDiffs, projectRoot);

    const confirmed = await confirmAction('Accept all changes?');

    // Cleanup temp files
    for (const cleanup of cleanups) cleanup();

    if (!confirmed) {
      output.info('Changes discarded.');
      return;
    }
  } else {
    // Terminal fallback: show compact summary (diffs are already summarized above)
    // Show the raw diff portion for terminal users
    const diffSection = extractDiffSection(finalResponse);
    if (diffSection) {
      output.showDiff('changes', '', diffSection);
    }

    const confirmed = await confirmAction('Apply all changes?');
    if (!confirmed) {
      output.info('Changes discarded.');
      return;
    }
  }

  // Apply changes — pure file I/O, no AI
  const written = applyParsedDiffs(parsedDiffs, projectRoot);

  output.phaseLabel('Done');
  output.info(`Applied changes to ${written.length} file(s):`);
  for (const f of written) {
    console.log(output.formatWrittenFile(f));
  }
}

// ─── VS Code Integration ───────────────────────────────────────────────────

function isInsideVSCodeTerminal(): boolean {
  return !!process.env.VSCODE_IPC_HOOK_CLI || process.env.TERM_PROGRAM === 'vscode';
}

/**
 * Open VS Code diff for each changed file.
 * Returns an array of cleanup functions to remove temp files.
 */
function openAllDiffsInVSCode(
  diffs: ParsedFileDiff[],
  projectRoot: string,
): (() => void)[] {
  const cleanups: (() => void)[] = [];

  for (const diff of diffs) {
    const absolutePath = path.resolve(projectRoot, diff.filePath);
    const dir = path.dirname(absolutePath);
    const baseName = path.basename(absolutePath);
    const proposedPath = path.join(dir, `.openmerlin-proposed-${baseName}`);

    // Ensure directory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // For new files, create empty original so diff works
    let createdOriginal = false;
    if (!fs.existsSync(absolutePath)) {
      fs.writeFileSync(absolutePath, '', 'utf-8');
      createdOriginal = true;
    }

    // Reconstruct the proposed file content
    const proposed = reconstructFile(diff, projectRoot);
    fs.writeFileSync(proposedPath, proposed, 'utf-8');

    try {
      execSync(`code -r --diff "${absolutePath}" "${proposedPath}"`, { stdio: 'ignore' });
      output.vscodeDiffOpened(diff.filePath);
    } catch {
      // VS Code command failed — fall through
    }

    cleanups.push(() => {
      try { fs.unlinkSync(proposedPath); } catch { /* ignore */ }
      if (createdOriginal) {
        try { fs.unlinkSync(absolutePath); } catch { /* ignore */ }
      }
    });
  }

  return cleanups;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract just the diff section from the LLM response for terminal display.
 */
function extractDiffSection(response: string): string | null {
  const match = response.match(/```diff\s*\n([\s\S]*?)```/);
  if (match) return match[1].trim();

  // Try to find raw diff blocks
  const diffStart = response.indexOf('--- ');
  if (diffStart !== -1) {
    const markerIdx = response.indexOf(DIFF_COMPLETE_MARKER, diffStart);
    if (markerIdx !== -1) {
      return response.slice(diffStart, markerIdx).trim();
    }
    return response.slice(diffStart).trim();
  }

  return null;
}

function formatToolArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return '';
  const truncate = (v: unknown): string => {
    const s = String(v);
    return s.length > 40 ? s.slice(0, 40) + '…' : s;
  };
  if (entries.length === 1) return truncate(entries[0][1]);
  return entries.map(([k, v]) => `${k}=${truncate(v)}`).slice(0, 3).join(', ');
}
