import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import type { Config } from './config.js';
import { callLLM } from './llm.js';
import type { LLMMessage } from './llm.js';
import { runWorker, type Subtask, type WorkerResult } from './worker.js';
import { groupDiffsByFile, applyDiffs, isInsideVSCodeTerminal, openVSCodeDiffPreview, type FileDiff } from './diffEngine.js';
import { confirmAction } from './safety.js';
import * as output from './output.js';

const PLAN_FILENAME = '.openmerlin-plan.md';

// ─── Orchestrator System Prompt ─────────────────────────────────────────────

const ORCHESTRATOR_SYSTEM_PROMPT = `You are a task decomposition engine. Given a coding task and a project file tree, break it into independent subtasks that can be executed in parallel by separate worker agents.

For each subtask, list ONLY the files that subtask needs to read or modify.

Return ONLY a JSON object with this exact shape:
{
  "subtasks": [
    { "description": "what this worker should do", "files": ["src/foo.ts", "src/bar.ts"] }
  ]
}

Rules:
- Each subtask must be independent — no subtask should depend on another's output.
- Minimize file overlap between subtasks. If two subtasks must touch the same file, note it in the description.
- Keep subtask count reasonable (2–6 for most tasks).
- File paths must be relative to the project root.
- Do not include any text outside the JSON object.`;

// ─── Types ──────────────────────────────────────────────────────────────────

interface ApprovalChoice {
  action: 'apply' | 'skip' | 'edit';
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * runTask — the public API for multi-agent orchestration.
 * 1. Decomposes the task into subtasks via LLM
 * 2. Dispatches workers in parallel
 * 3. Collects and groups diffs
 * 4. Presents diffs for approval
 * 5. Applies approved changes
 */
export async function runTask(
  prompt: string,
  config: Config,
  projectContext: string,
  projectRoot: string,
): Promise<void> {
  output.orchestratorStatus('Decomposing task into subtasks...');

  // ── Step 1: Decompose ─────────────────────────────────────────────────────
  const subtasks = await decompose(prompt, projectContext, config);
  if (!subtasks || subtasks.length === 0) {
    output.error('Could not decompose task into subtasks.');
    return;
  }

  output.orchestratorStatus(`Created ${subtasks.length} subtask(s)`);

  // Write plan to temp file for review
  const planPath = path.join(projectRoot, PLAN_FILENAME);
  const planLines = [
    '# OpenMerlin — Multi-Agent Plan',
    '',
    '> Review the subtasks below, then return to the terminal to approve or reject.',
    '',
    ...subtasks.map((st) =>
      `## Worker ${st.id}\n- **Task:** ${st.description}\n- **Files:** ${st.files.map(f => `\`${f}\``).join(', ')}\n`
    ),
  ];
  fs.writeFileSync(planPath, planLines.join('\n'), 'utf-8');

  if (isInsideVSCodeTerminal()) {
    try {
      execSync(`code -r "${planPath}"`, { stdio: 'ignore' });
    } catch { /* ignore */ }
  }

  output.info(`Plan written to ${PLAN_FILENAME} — review it, then confirm below.`);
  const proceed = await confirmAction('Proceed with plan?');

  // Cleanup
  try { fs.unlinkSync(planPath); } catch { /* ignore */ }

  if (!proceed) {
    output.info('Plan cancelled.');
    return;
  }

  // ── Step 2: Dispatch workers in parallel ──────────────────────────────────
  output.orchestratorStatus('Dispatching workers in parallel...');

  const settled = await Promise.allSettled(
    subtasks.map((st) => runWorker(st, config, projectRoot)),
  );

  // ── Step 3: Collect results ───────────────────────────────────────────────
  const results: WorkerResult[] = [];
  const allUsage: { agentId: string; inputTokens: number; outputTokens: number }[] = [];

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    const subtask = subtasks[i];

    if (outcome.status === 'fulfilled') {
      const result = outcome.value;
      results.push(result);
      allUsage.push({
        agentId: `worker-${result.subtaskId}`,
        inputTokens: result.tokenUsage.promptTokens,
        outputTokens: result.tokenUsage.completionTokens,
      });

      if (result.error) {
        output.warn(`Worker ${subtask.id} completed with error: ${result.error}`);
      } else {
        output.workerStatus(
          subtask.id,
          `Done — ${result.diffs.length} file(s) changed`,
        );
      }
    } else {
      // Worker threw — skip it
      output.warn(
        `Worker ${subtask.id} failed: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
      );
    }
  }

  // Gather all diffs
  const allDiffs: FileDiff[] = [];
  for (const r of results) {
    allDiffs.push(...r.diffs);
  }

  if (allDiffs.length === 0) {
    output.info('No changes produced by any worker.');
    output.tokenReport(allUsage);
    return;
  }

  // ── Step 4: Group diffs and present ───────────────────────────────────────
  const grouped = groupDiffsByFile(allDiffs);
  console.log('');
  output.orchestratorStatus(`Changes across ${grouped.size} file(s):`);
  output.showGroupedDiffs(grouped);

  // ── Step 5: Token report ──────────────────────────────────────────────────
  output.tokenReport(allUsage);

  // ── Step 6: Approval ──────────────────────────────────────────────────────
  const choice = await promptApproval();

  if (choice.action === 'skip') {
    output.info('Skipped — no changes written.');
    return;
  }

  if (choice.action === 'apply') {
    const resolved = resolveConflicts(grouped);

    if (isInsideVSCodeTerminal()) {
      // Open all diffs in VS Code for review
      const cleanups: (() => void)[] = [];
      for (const diff of resolved) {
        const { cleanup } = openVSCodeDiffPreview(diff, projectRoot);
        cleanups.push(cleanup);
        output.vscodeDiffOpened(diff.filePath);
      }

      const confirmed = await confirmAction('Accept all changes?');

      // Cleanup temp files
      for (const cleanup of cleanups) cleanup();

      if (!confirmed) {
        output.info('Cancelled — no changes written.');
        return;
      }
    }

    const written = applyDiffs(resolved, projectRoot);
    output.orchestratorStatus(`Applied changes to ${written.length} file(s):`);
    for (const f of written) {
      console.log(output.formatWrittenFile(f));
    }
    return;
  }

  if (choice.action === 'edit') {
    // Per-file approval with diff preview
    await perFileApproval(grouped, projectRoot);
  }
}

// ─── Decompose ──────────────────────────────────────────────────────────────

async function decompose(
  task: string,
  projectContext: string,
  config: Config,
): Promise<Subtask[] | null> {
  const messages: LLMMessage[] = [
    { role: 'system', content: ORCHESTRATOR_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `## Project Context\n${projectContext}\n\n## Task\n${task}`,
    },
  ];

  try {
    const response = await callLLM(config, messages);
    const content = response.content.trim();

    // Extract JSON (handle markdown fences)
    let jsonStr = content;
    const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    const parsed = JSON.parse(jsonStr) as {
      subtasks: { description: string; files: string[] }[];
    };

    if (!parsed.subtasks || !Array.isArray(parsed.subtasks)) {
      return null;
    }

    return parsed.subtasks.map((st, i) => ({
      id: String(i + 1),
      description: st.description,
      files: st.files,
    }));
  } catch (err) {
    output.warn(
      `Decomposition failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// ─── Approval ───────────────────────────────────────────────────────────────

async function promptApproval(): Promise<ApprovalChoice> {
  console.log('');
  output.info('What would you like to do?');
  console.log('    a) apply  — write all changes to disk');
  console.log('    s) skip   — discard all changes');
  console.log('    e) edit   — review each file individually');
  console.log('');

  return new Promise((resolve) => {
    process.stdout.write('  Choice (a/s/e): ');

    if (process.stdin.isTTY) {
      process.stdin.pause();
      process.stdin.setRawMode(true);
      process.stdin.resume();

      const onData = (data: Buffer): void => {
        const char = data.toString().charAt(0).toLowerCase();
        if (char !== 'a' && char !== 's' && char !== 'e') return;

        process.stdin.removeListener('data', onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write(char + '\n');

        const map: Record<string, ApprovalChoice['action']> = {
          a: 'apply',
          s: 'skip',
          e: 'edit',
        };
        resolve({ action: map[char] });
      };

      process.stdin.on('data', onData);
    } else {
      // Non-TTY fallback
      const readline = require('node:readline') as typeof import('node:readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false,
      });
      rl.once('line', (line: string) => {
        rl.close();
        const c = line.trim().toLowerCase().charAt(0);
        const map: Record<string, ApprovalChoice['action']> = {
          a: 'apply',
          s: 'skip',
          e: 'edit',
        };
        resolve({ action: map[c] ?? 'skip' });
      });
    }
  });
}

// ─── Per-File Approval ──────────────────────────────────────────────────────

async function perFileApproval(
  grouped: Map<string, FileDiff[]>,
  projectRoot: string,
): Promise<void> {
  const approved: FileDiff[] = [];
  const useVSCode = isInsideVSCodeTerminal();

  for (const [filePath, diffs] of grouped) {
    console.log('');
    output.orchestratorStatus(`File: ${filePath}`);

    // Show the last diff for this file (latest worker wins for display)
    const diff = diffs[diffs.length - 1];

    if (useVSCode) {
      // Open VS Code diff viewer
      const { cleanup } = openVSCodeDiffPreview(diff, projectRoot);
      output.vscodeDiffOpened(filePath);

      const accept = await confirmAction(`Apply changes to ${filePath}?`);
      cleanup();

      if (accept) {
        approved.push(diff);
      } else {
        output.info(`Skipped: ${filePath}`);
      }
    } else {
      // Terminal diff fallback
      output.showSingleDiff(diff.patch);

      const accept = await confirmAction(`Apply changes to ${filePath}?`);
      if (accept) {
        approved.push(diff);
      } else {
        output.info(`Skipped: ${filePath}`);
      }
    }
  }

  if (approved.length > 0) {
    const written = applyDiffs(approved, projectRoot);
    output.orchestratorStatus(`Applied changes to ${written.length} file(s):`);
    for (const f of written) {
      console.log(output.formatWrittenFile(f));
    }
  } else {
    output.info('No changes applied.');
  }
}

// ─── Conflict Resolution ────────────────────────────────────────────────────

/**
 * If multiple diffs target the same file, take the last one (latest worker).
 * Returns a flat array of non-conflicting diffs.
 */
function resolveConflicts(grouped: Map<string, FileDiff[]>): FileDiff[] {
  const resolved: FileDiff[] = [];
  for (const [, diffs] of grouped) {
    // Last diff wins
    resolved.push(diffs[diffs.length - 1]);
  }
  return resolved;
}
