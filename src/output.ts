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
  console.log(chalk.bold.cyan('  ║       termilynx CLI           ║'));
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

export function hint(msg: string): void {
  console.log(chalk.dim(`  💡 ${msg}`));
}

export function showHelp(): void {
  console.log('');
  console.log(chalk.bold.cyan('  Available commands:'));
  console.log('');
  console.log(chalk.white('    model / switch') + chalk.dim('  — Change AI provider or model'));
  console.log(chalk.white('    config        ') + chalk.dim('  — Open full configuration menu'));
  console.log(chalk.white('    clear         ') + chalk.dim('  — Clear conversation history'));
  console.log(chalk.white('    help          ') + chalk.dim('  — Show this help'));
  console.log(chalk.white('    exit / quit   ') + chalk.dim('  — Exit TermiLynx'));
  console.log('');
  console.log(chalk.dim('  Or just type what you want TermiLynx to do!'));
  console.log('');
}
