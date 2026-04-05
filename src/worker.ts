import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from './config.js';
import { callLLM } from './llm.js';
import type { LLMMessage, TokenUsage } from './llm.js';
import { generateDiff, type FileDiff } from './diffEngine.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Subtask {
  id: string;
  description: string;
  files: string[];
}

export interface WorkerResult {
  subtaskId: string;
  diffs: FileDiff[];
  tokenUsage: TokenUsage;
  error?: string;
}

// ─── System Prompt ──────────────────────────────────────────────────────────

const WORKER_SYSTEM_PROMPT = `You are a code editor agent. You receive file contents and a task.
Return ONLY a JSON object with this exact shape:
{ "files": [{ "path": "<relative path>", "content": "<full updated file content>" }] }

Rules:
- Include ONLY files you actually changed.
- Provide the COMPLETE file content — no placeholders, no elisions.
- If no changes are needed, return { "files": [] }.
- Do not include any text outside the JSON object.`;

// ─── Worker Execution ───────────────────────────────────────────────────────

/**
 * Run a single worker agent for a subtask.
 * Reads the scoped files, sends them to the LLM, and returns diffs.
 */
export async function runWorker(
  subtask: Subtask,
  config: Config,
  projectRoot: string,
): Promise<WorkerResult> {
  const agentId = `worker-${subtask.id}`;
  const totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0 };

  // Read scoped file contents
  const fileContents: { path: string; content: string }[] = [];
  for (const filePath of subtask.files) {
    const abs = path.resolve(projectRoot, filePath);
    try {
      const content = fs.readFileSync(abs, 'utf-8');
      fileContents.push({ path: filePath, content });
    } catch {
      // File doesn't exist yet — worker can create it
      fileContents.push({ path: filePath, content: '' });
    }
  }

  // Build context message
  const filesBlock = fileContents
    .map((f) => `--- ${f.path} ---\n${f.content}\n--- end ${f.path} ---`)
    .join('\n\n');

  const messages: LLMMessage[] = [
    { role: 'system', content: WORKER_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `## Task\n${subtask.description}\n\n## Files\n${filesBlock}`,
    },
  ];

  // Call LLM (single-shot, no tool loop)
  const response = await callLLM(config, messages);

  // Track tokens
  if (response.usage) {
    totalUsage.promptTokens += response.usage.promptTokens;
    totalUsage.completionTokens += response.usage.completionTokens;
  }

  // Parse the JSON response
  const content = response.content.trim();

  // Extract JSON from response (handle markdown fences)
  let jsonStr = content;
  const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  let parsed: { files: { path: string; content: string }[] };
  try {
    parsed = JSON.parse(jsonStr) as { files: { path: string; content: string }[] };
  } catch {
    return {
      subtaskId: subtask.id,
      diffs: [],
      tokenUsage: totalUsage,
      error: `Failed to parse worker response as JSON. Raw: ${content.slice(0, 200)}`,
    };
  }

  if (!parsed.files || !Array.isArray(parsed.files)) {
    return {
      subtaskId: subtask.id,
      diffs: [],
      tokenUsage: totalUsage,
      error: 'Worker response missing "files" array',
    };
  }

  // Generate diffs for each changed file
  const diffs: FileDiff[] = [];
  for (const file of parsed.files) {
    // Find original content from our scoped reads
    const original = fileContents.find((f) => f.path === file.path);
    const originalContent = original?.content ?? '';

    // Skip if content is identical
    if (originalContent === file.content) continue;

    diffs.push(generateDiff(file.path, originalContent, file.content));
  }

  return {
    subtaskId: subtask.id,
    diffs,
    tokenUsage: totalUsage,
  };
}
