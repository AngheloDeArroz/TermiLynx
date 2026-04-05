import chalk from 'chalk';
import { createPatch } from 'diff';

export function thinking(): void {
  console.log(chalk.dim('  Thinking...'));
}

export function toolStart(name: string): void {
  console.log(chalk.cyan(`  Running tool: ${name}`));
}

export function toolDone(name: string): void {
  console.log(chalk.green(`  ✔ Tool complete: ${name}`));
}

export function editingFile(filePath: string): void {
  console.log(chalk.yellow(`  Editing file: ${filePath}`));
}

export function showDiff(filePath: string, before: string, after: string): void {
  const patch = createPatch(filePath, before, after, 'original', 'modified');
  const lines = patch.split('\n');

  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      console.log(chalk.green(`  ${line}`));
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      console.log(chalk.red(`  ${line}`));
    } else if (line.startsWith('@@')) {
      console.log(chalk.magenta(`  ${line}`));
    } else {
      console.log(chalk.dim(`  ${line}`));
    }
  }
}

export function vscodeDiffOpened(filePath: string): void {
  console.log(chalk.cyan(`  📂 Diff opened in VS Code → ${filePath}`));
}


export function agentReply(text: string): void {
  console.log('');
  console.log(chalk.white(text));
  console.log('');
}

export function error(msg: string): void {
  console.log(chalk.red(`  ✖ Error: ${msg}`));
}

export function info(msg: string): void {
  console.log(chalk.blue(`  ℹ ${msg}`));
}

export function warn(msg: string): void {
  console.log(chalk.yellow(`  ⚠ ${msg}`));
}

export function planning(): void {
  console.log(chalk.magenta('  Planning...'));
}

export function planStep(index: number, step: string): void {
  console.log(chalk.white(`    ${index + 1}. ${step}`));
}

export function banner(cwd: string, modelInfo?: { provider: string; model: string }): void {
  console.log('');
  console.log(chalk.bold.cyan('  ╔═══════════════════════════════╗'));
  console.log(chalk.bold.cyan('  ║       OpenMerlin CLI          ║'));
  console.log(chalk.bold.cyan('  ╚═══════════════════════════════╝'));
  console.log(chalk.dim(`  Project: ${cwd}`));
  if (modelInfo) {
    console.log(chalk.green(`  AI:      ${modelInfo.provider} / ${modelInfo.model}`));
  }
  console.log('');
}

export function showActiveModel(provider: string, model: string): void {
  console.log(chalk.green(`  🤖 Active AI: ${provider} / ${model}`));
}

export function goodbye(): void {
  console.log(chalk.dim('  Goodbye.'));
}

export function tokenEstimate(count: number): void {
  console.log(chalk.dim(`  ⏱ ~${count.toLocaleString()} input tokens`));
}

export function hint(msg: string): void {
  console.log(chalk.dim(`  💡 ${msg}`));
}

export function showHelp(): void {
  console.log('');
  console.log(chalk.bold.cyan('  Commands:'));
  console.log('');
  console.log(chalk.white('    --model   ') + chalk.dim(' Change AI provider or model'));
  console.log(chalk.white('    --config  ') + chalk.dim(' Open full configuration menu'));
  console.log(chalk.white('    --clear   ') + chalk.dim(' Clear conversation history'));
  console.log(chalk.white('    --multi   ') + chalk.dim(' Prefix: --multi <task> (parallel worker agents)'));
  console.log(chalk.white('    --help    ') + chalk.dim(' Show this help'));
  console.log(chalk.white('    --exit    ') + chalk.dim(' Exit OpenMerlin-CLI'));
  console.log('');
  console.log(chalk.dim('  Anything else is sent as a prompt to the AI.'));
  console.log('');
}

// ─── Multi-Agent Orchestration Output ─────────────────────────────────────

export function orchestratorStatus(msg: string): void {
  console.log(chalk.bold.magenta(`  🔀 ${msg}`));
}

export function workerStatus(id: string, msg: string): void {
  console.log(chalk.cyan(`    [Worker ${id}] ${msg}`));
}

export function showGroupedDiffs(grouped: Map<string, { patch: string }[]>): void {
  console.log('');
  for (const [filePath, diffs] of grouped) {
    const patch = diffs[diffs.length - 1].patch;
    const { added, removed } = countDiffLines(patch);

    const isNew = removed === 0 && added > 0;
    const label = isNew
      ? chalk.green('NEW')
      : chalk.yellow('MOD');

    const stats = isNew
      ? chalk.green(`+${added}`)
      : `${chalk.green(`+${added}`)} ${chalk.red(`-${removed}`)}`;

    const conflict = diffs.length > 1
      ? chalk.yellow(` ⚠ ${diffs.length} workers`)
      : '';

    console.log(`    ${label}  ${chalk.white(filePath)}  ${stats}${conflict}`);
  }
  console.log('');
}

/**
 * Show full diff with syntax coloring — used in per-file "edit" approval mode.
 */
export function showSingleDiff(patch: string): void {
  const lines = patch.split('\n');
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      console.log(chalk.green(`    ${line}`));
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      console.log(chalk.red(`    ${line}`));
    } else if (line.startsWith('@@')) {
      console.log(chalk.magenta(`    ${line}`));
    } else {
      console.log(chalk.dim(`    ${line}`));
    }
  }
}

function countDiffLines(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}

export function tokenReport(
  usages: { agentId: string; inputTokens: number; outputTokens: number }[],
): void {
  if (usages.length === 0) return;

  console.log('');
  orchestratorStatus('Token Usage:');
  console.log(
    chalk.dim('    ┌──────────────────┬──────────────┬──────────────┐'),
  );
  console.log(
    chalk.dim('    │') +
      chalk.bold(' Agent            ') +
      chalk.dim('│') +
      chalk.bold(' Input        ') +
      chalk.dim('│') +
      chalk.bold(' Output       ') +
      chalk.dim('│'),
  );
  console.log(
    chalk.dim('    ├──────────────────┼──────────────┼──────────────┤'),
  );

  let totalIn = 0;
  let totalOut = 0;
  for (const u of usages) {
    totalIn += u.inputTokens;
    totalOut += u.outputTokens;
    const agent = u.agentId.padEnd(16);
    const inp = u.inputTokens.toLocaleString().padStart(12);
    const outp = u.outputTokens.toLocaleString().padStart(12);
    console.log(
      chalk.dim('    │') +
        ` ${agent} ` +
        chalk.dim('│') +
        ` ${inp} ` +
        chalk.dim('│') +
        ` ${outp} ` +
        chalk.dim('│'),
    );
  }

  console.log(
    chalk.dim('    ├──────────────────┼──────────────┼──────────────┤'),
  );
  const totalAgent = 'TOTAL'.padEnd(16);
  const totalInStr = totalIn.toLocaleString().padStart(12);
  const totalOutStr = totalOut.toLocaleString().padStart(12);
  console.log(
    chalk.dim('    │') +
      chalk.bold(` ${totalAgent} `) +
      chalk.dim('│') +
      chalk.bold(` ${totalInStr} `) +
      chalk.dim('│') +
      chalk.bold(` ${totalOutStr} `) +
      chalk.dim('│'),
  );
  console.log(
    chalk.dim('    └──────────────────┴──────────────┴──────────────┘'),
  );
}

export function formatWrittenFile(filePath: string): string {
  return chalk.green(`    ✔ ${filePath}`);
}
