#!/usr/bin/env node

import * as readline from 'node:readline';
import { loadConfig, promptForConfig, promptForConfigMenu, getProviderLabel } from './config.js';
import type { Config } from './config.js';
import { scanProject, formatProjectContext } from './scanner.js';
import { runAgent } from './agent.js';
import type { LLMMessage } from './llm.js';
import * as output from './output.js';

async function main(): Promise<void> {
  const cwd = process.cwd();

  // Auto-load last-used profile — only prompt if no config exists
  let config: Config | null = loadConfig();
  if (!config) {
    output.banner(cwd);
    console.log('\n  Welcome to OpenMerlin-CLI!\n');
    config = await promptForConfig();
  }

  // Re-draw banner with model info
  console.clear();
  output.banner(cwd, {
    provider: getProviderLabel(config.provider),
    model: config.model,
  });

  // Scan project
  output.info('Scanning project...');
  const projectSummary = scanProject(cwd);
  const projectContext = formatProjectContext(projectSummary);
  output.info('Project scanned. Ready.');
  output.hint('Type "--help" to see available commands.\n');

  // Message history persists across the session
  const history: LLMMessage[] = [];

  // Helper to create a fresh readline interface each prompt cycle.
  // This avoids conflicts with raw-mode stdin usage in confirmAction.
  function askQuestion(query: string): Promise<string> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      rl.question(query, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }

  // Handle SIGINT gracefully
  process.on('SIGINT', () => {
    console.log('');
    output.goodbye();
    process.exit(0);
  });

  // Main prompt loop
  while (true) {
    const input = await askQuestion('> What do you want to do? ');
    const trimmed = input.trim();

    if (!trimmed) {
      continue;
    }

    if (trimmed === '--exit' || trimmed === '--quit') {
      output.goodbye();
      process.exit(0);
    }

    if (trimmed === '--clear') {
      history.length = 0;
      output.info('Conversation history cleared.');
      continue;
    }

    if (trimmed === '--config' || trimmed === '--model' || trimmed === '--switch') {
      const updated = await promptForConfigMenu(config);
      if (updated !== null) {
        config = updated;
        output.showActiveModel(getProviderLabel(config.provider), config.model);
      }
      continue;
    }

    if (trimmed.startsWith('--multi ')) {
      const task = trimmed.slice('--multi '.length).trim();
      if (task) {
        try {
          const { runTask } = await import('./orchestrator.js');
          await runTask(task, config, projectContext, cwd);
        } catch (err) {
          output.error(err instanceof Error ? err.message : String(err));
        }
      } else {
        output.error('Usage: --multi <task description>');
      }
      continue;
    }

    if (trimmed === '--help') {
      output.showHelp();
      continue;
    }

    // Catch-all: any --command that wasn't matched above is invalid
    if (trimmed.startsWith('--')) {
      output.error(`Unknown command: ${trimmed}. Type --help for available commands.`);
      continue;
    }

    try {
      await runAgent(trimmed, history, config, projectContext, cwd);
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
