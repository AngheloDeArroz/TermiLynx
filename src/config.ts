import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline';
import chalk from 'chalk';

// ─── Config Interface ───────────────────────────────────────────────────────

export interface Config {
  provider: string;
  apiKey: string;
  model: string;
  baseURL: string;
}

export interface ProfileEntry {
  name: string; // user-friendly label e.g. "GPT-4o", "Claude Sonnet"
  config: Config;
}

export interface ConfigFile {
  profiles: ProfileEntry[];
  activeIndex: number;
}

// ─── Provider Registry ──────────────────────────────────────────────────────

interface ProviderInfo {
  label: string;
  baseURL: string;
  keyPrefix: string | null;
  requiresKey: boolean;
}

const PROVIDERS: Record<string, ProviderInfo> = {
  openai: {
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    keyPrefix: 'sk-',
    requiresKey: true,
  },
  anthropic: {
    label: 'Anthropic',
    baseURL: 'https://api.anthropic.com/v1',
    keyPrefix: 'sk-ant-',
    requiresKey: true,
  },
  gemini: {
    label: 'Google Gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyPrefix: 'AIzaSy',
    requiresKey: true,
  },
  groq: {
    label: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    keyPrefix: 'gsk_',
    requiresKey: true,
  },
  openrouter: {
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    keyPrefix: 'sk-or-',
    requiresKey: true,
  },
  ollama: {
    label: 'Ollama (local)',
    baseURL: 'http://localhost:11434/v1',
    keyPrefix: null,
    requiresKey: false,
  },
};

const PROVIDER_KEYS = Object.keys(PROVIDERS);

// ─── File Paths ─────────────────────────────────────────────────────────────

const CONFIG_DIR = path.join(os.homedir(), '.myagent');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

// ─── Provider Detection ─────────────────────────────────────────────────────

function detectProvider(apiKey: string): string | null {
  // Order is strict — do not change
  if (apiKey.startsWith('sk-ant-')) return 'anthropic';
  if (apiKey.startsWith('sk-or-')) return 'openrouter';
  if (apiKey.startsWith('gsk_')) return 'groq';
  if (apiKey.startsWith('AIzaSy')) return 'gemini';
  if (apiKey.startsWith('sk-')) return 'openai';
  return null;
}

// ─── Helper: Get display name for a provider key ────────────────────────────

export function getProviderLabel(providerKey: string): string {
  return PROVIDERS[providerKey]?.label ?? providerKey;
}

// ─── Model Fetching ─────────────────────────────────────────────────────────

interface ModelEntry {
  id: string;
}

interface ModelsResponse {
  data: ModelEntry[];
}

async function fetchModels(baseURL: string, apiKey: string): Promise<string[]> {
  try {
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const res = await fetch(`${baseURL}/models`, { headers });

    if (!res.ok) return [];

    const data = (await res.json()) as ModelsResponse;
    if (!data.data || !Array.isArray(data.data)) return [];

    return data.data
      .map((m: ModelEntry) => m.id)
      .sort();
  } catch {
    return [];
  }
}

// ─── Readline Helpers ───────────────────────────────────────────────────────

function askQuestion(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

function askMasked(question: string): Promise<string> {
  // Note: masked input works correctly on macOS, Linux, and Windows Terminal (WT)
  // Characters may still echo on legacy Windows cmd.exe — this is a terminal limitation
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Override _writeToOutput to mask input
    const originalWrite = (rl as unknown as Record<string, unknown>)._writeToOutput as (s: string) => void;
    (rl as unknown as Record<string, unknown>)._writeToOutput = function (stringToWrite: string) {
      if (stringToWrite.includes(question)) {
        originalWrite.call(rl, stringToWrite);
      } else {
        originalWrite.call(rl, '*'.repeat(stringToWrite.length));
      }
    };

    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

// ─── Config Persistence (Multi-Profile) ─────────────────────────────────────

export function loadConfigFile(): ConfigFile | null {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      return null;
    }
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed !== 'object' || parsed === null) return null;

    // New multi-profile format
    if ('profiles' in parsed && 'activeIndex' in parsed) {
      const file = parsed as Record<string, unknown>;
      const profiles = file.profiles;
      const activeIndex = file.activeIndex;

      if (Array.isArray(profiles) && typeof activeIndex === 'number') {
        const validProfiles: ProfileEntry[] = [];
        for (const p of profiles) {
          if (
            typeof p === 'object' && p !== null &&
            'name' in p && 'config' in p &&
            typeof (p as Record<string, unknown>).name === 'string'
          ) {
            const cfg = (p as Record<string, unknown>).config as Record<string, unknown>;
            if (
              typeof cfg.provider === 'string' &&
              typeof cfg.apiKey === 'string' &&
              typeof cfg.model === 'string' &&
              typeof cfg.baseURL === 'string'
            ) {
              validProfiles.push({
                name: (p as Record<string, unknown>).name as string,
                config: {
                  provider: cfg.provider,
                  apiKey: cfg.apiKey,
                  model: cfg.model,
                  baseURL: cfg.baseURL,
                },
              });
            }
          }
        }

        if (validProfiles.length > 0) {
          return {
            profiles: validProfiles,
            activeIndex: Math.min(activeIndex, validProfiles.length - 1),
          };
        }
      }
    }

    // Backward compatibility: old single-config format
    if ('provider' in parsed && 'apiKey' in parsed && 'model' in parsed && 'baseURL' in parsed) {
      const cfg = parsed as Record<string, unknown>;
      if (
        typeof cfg.provider === 'string' &&
        typeof cfg.apiKey === 'string' &&
        typeof cfg.model === 'string' &&
        typeof cfg.baseURL === 'string'
      ) {
        const config: Config = {
          provider: cfg.provider,
          apiKey: cfg.apiKey,
          model: cfg.model,
          baseURL: cfg.baseURL,
        };
        const providerLabel = getProviderLabel(config.provider);
        return {
          profiles: [{
            name: `${providerLabel} / ${config.model}`,
            config,
          }],
          activeIndex: 0,
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/** Legacy helper — returns the active config or null */
export function loadConfig(): Config | null {
  const file = loadConfigFile();
  if (!file || file.profiles.length === 0) return null;
  return file.profiles[file.activeIndex].config;
}

export function saveConfigFile(configFile: ConfigFile): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  const tempPath = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tempPath, JSON.stringify(configFile, null, 2), 'utf-8');
  fs.renameSync(tempPath, CONFIG_PATH);

  // chmod 600 on POSIX systems
  if (process.platform !== 'win32') {
    fs.chmodSync(CONFIG_PATH, 0o600);
  }
}

/** Legacy helper — saves a single config (wraps it in a profile) */
export function saveConfig(config: Config): void {
  const existing = loadConfigFile();
  const providerLabel = getProviderLabel(config.provider);
  const newProfile: ProfileEntry = {
    name: `${providerLabel} / ${config.model}`,
    config,
  };

  if (existing) {
    // Check if a profile with the same provider+model already exists
    const existingIdx = existing.profiles.findIndex(
      (p) => p.config.provider === config.provider && p.config.model === config.model,
    );
    if (existingIdx >= 0) {
      existing.profiles[existingIdx] = newProfile;
      existing.activeIndex = existingIdx;
    } else {
      existing.profiles.push(newProfile);
      existing.activeIndex = existing.profiles.length - 1;
    }
    saveConfigFile(existing);
  } else {
    saveConfigFile({ profiles: [newProfile], activeIndex: 0 });
  }
}

// ─── Step 1: Provider Selection ─────────────────────────────────────────────

async function selectProvider(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('\n  Select your AI provider:\n');
  PROVIDER_KEYS.forEach((key, i) => {
    const info = PROVIDERS[key];
    const suffix = !info.requiresKey ? ' (local, no key needed)' : '';
    console.log(`    ${i + 1}. ${info.label}${suffix}`);
  });
  console.log('');

  let providerKey = '';
  while (!providerKey) {
    const answer = await askQuestion(rl, `  Choice [1-${PROVIDER_KEYS.length}]: `);
    const num = parseInt(answer, 10);
    if (num >= 1 && num <= PROVIDER_KEYS.length) {
      providerKey = PROVIDER_KEYS[num - 1];
    } else {
      console.log(`  Please enter a number between 1 and ${PROVIDER_KEYS.length}.`);
    }
  }

  rl.close();
  return providerKey;
}

// ─── Step 2: API Key Input ──────────────────────────────────────────────────

async function getApiKey(providerKey: string): Promise<string> {
  const provider = PROVIDERS[providerKey];

  if (!provider.requiresKey) {
    return 'ollama';
  }

  let apiKey = '';
  while (!apiKey) {
    apiKey = await askMasked('  Paste your API key: ');
    if (!apiKey) {
      console.log('  API key cannot be empty.');
      continue;
    }

    // Detect provider from key prefix
    const detected = detectProvider(apiKey);
    if (detected && detected === providerKey) {
      console.log(`\n  ✓ Detected: ${PROVIDERS[detected].label}`);
    } else if (detected && detected !== providerKey) {
      console.log(
        `\n  ⚠ Key prefix suggests ${PROVIDERS[detected].label} but you selected ${provider.label}. Continuing anyway.`,
      );
    }
  }

  return apiKey;
}

// ─── Step 3 & 4: Fetch and Select Model ─────────────────────────────────────

async function selectModel(
  providerKey: string,
  baseURL: string,
  apiKey: string,
  currentModel?: string,
): Promise<string> {
  console.log('\n  ✓ Fetching available models...');

  const models = await fetchModels(baseURL, apiKey);

  // Handle fetch failure or empty list
  if (models.length === 0) {
    if (providerKey === 'ollama') {
      console.log('\n  ⚠ No local models found.');
      console.log('    Pull one first: ollama pull llama3\n');
      console.log('  Type model name manually:\n');
    } else {
      console.log('\n  ⚠ Could not fetch model list. Type model name manually:\n');
    }

    return await askModelFreeform(currentModel);
  }

  // OpenRouter: always free-form (too many models for a numbered list)
  if (providerKey === 'openrouter') {
    console.log(`\n  ✓ Connected to OpenRouter\n`);
    console.log('  Type your model name:');
    console.log('    Suggestions:');
    console.log('      • openai/gpt-4o');
    console.log('      • anthropic/claude-sonnet-4-20250514');
    console.log('      • meta-llama/llama-3.3-70b-instruct');
    console.log('      • google/gemini-2.0-flash');
    console.log('');

    return await askModelFreeform(currentModel);
  }

  // Numbered list for everything else
  console.log('\n  Available models:');
  models.forEach((m, i) => {
    let suffix = '';
    if (currentModel && m === currentModel) {
      suffix = '  (current)';
    } else if (!currentModel && i === 0) {
      suffix = '  (default)';
    }
    console.log(`    ${i + 1}. ${m}${suffix}`);
  });
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const promptText = currentModel
    ? `  Select [1-${models.length}] or type model name, Enter to keep current: `
    : `  Select [1-${models.length}] or type model name, Enter for default: `;

  let selected = '';
  while (!selected) {
    const answer = await askQuestion(rl, promptText);

    // Enter with no input — use default/current
    if (!answer) {
      if (currentModel) {
        selected = currentModel;
      } else {
        selected = models[0];
      }
      break;
    }

    // Try as a number
    const num = parseInt(answer, 10);
    if (!isNaN(num) && num >= 1 && num <= models.length) {
      selected = models[num - 1];
      break;
    }

    // If it's not a valid number, treat as a model name typed manually
    if (isNaN(num) && answer.length > 0) {
      selected = answer;
      break;
    }

    console.log(`  Please enter a number between 1 and ${models.length}, or type a model name.`);
  }

  rl.close();
  return selected;
}

async function askModelFreeform(currentModel?: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let model = '';
  while (!model) {
    const answer = await askQuestion(rl, '  Model: ');
    if (!answer) {
      if (currentModel) {
        model = currentModel;
        break;
      }
      console.log('  Model name cannot be empty.');
      continue;
    }
    model = answer;
  }

  rl.close();
  return model;
}

// ─── Full Setup Flow (creates a new profile) ────────────────────────────────

export async function promptForConfig(): Promise<Config> {
  console.log('\n  Setting up a new AI profile...\n');

  // Step 1: Provider
  const providerKey = await selectProvider();
  const provider = PROVIDERS[providerKey];

  // Step 2: API Key
  const apiKey = await getApiKey(providerKey);

  // Validate key with a model fetch (handles 401 → re-prompt)
  if (provider.requiresKey) {
    let validKey = apiKey;
    let models = await fetchModels(provider.baseURL, validKey);

    // If empty, might be 401. Let's try to give user another chance.
    let retries = 0;
    while (models.length === 0 && retries < 2) {
      const authOk = await checkAuth(provider.baseURL, validKey);
      if (authOk === 'unauthorized') {
        console.log('\n  ⚠ Invalid API key. Please try again.');
        validKey = await askMasked('  Paste your API key: ');
        if (!validKey) continue;
        models = await fetchModels(provider.baseURL, validKey);
        retries++;
      } else {
        break;
      }
    }

    // Step 3 & 4: Model selection
    const model = await selectModel(providerKey, provider.baseURL, validKey);

    const config: Config = {
      provider: providerKey,
      apiKey: validKey,
      model,
      baseURL: provider.baseURL,
    };

    console.log('');
    console.log(`  ✓ Provider:  ${provider.label}`);
    console.log(`  ✓ Model:     ${model}`);
    console.log(`  ✓ Saved to profiles`);
    console.log('');

    saveConfig(config);
    return config;
  }

  // Ollama path (no key validation needed)
  const model = await selectModel(providerKey, provider.baseURL, '');

  const config: Config = {
    provider: providerKey,
    apiKey,
    model,
    baseURL: provider.baseURL,
  };

  console.log('');
  console.log(`  ✓ Provider:  ${provider.label}`);
  console.log(`  ✓ Model:     ${model}`);
  console.log(`  ✓ Saved to profiles`);
  console.log('');

  saveConfig(config);
  return config;
}

// ─── Auth Check Helper ──────────────────────────────────────────────────────

async function checkAuth(
  baseURL: string,
  apiKey: string,
): Promise<'ok' | 'unauthorized' | 'forbidden' | 'error'> {
  try {
    const res = await fetch(`${baseURL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return 'ok';
    if (res.status === 401) return 'unauthorized';
    if (res.status === 403) return 'forbidden';
    return 'error';
  } catch {
    return 'error';
  }
}

// ─── Startup Profile Picker ─────────────────────────────────────────────────

/**
 * Called at startup. If profiles exist, lets the user pick one or add a new one.
 * Returns the chosen Config.
 */
export async function promptForStartupConfig(): Promise<Config> {
  const configFile = loadConfigFile();

  // No profiles at all — run first-time setup
  if (!configFile || configFile.profiles.length === 0) {
    console.log('\n  Welcome to TermiLynx!\n');
    return await promptForConfig();
  }

  // Only one profile — use it automatically
  if (configFile.profiles.length === 1) {
    const profile = configFile.profiles[0];
    console.log(chalk.dim(`  Using profile: ${profile.name}`));
    return profile.config;
  }

  // Multiple profiles — let user pick
  console.log('');
  console.log(chalk.bold.cyan('  Select an AI profile:\n'));

  configFile.profiles.forEach((p, i) => {
    const active = i === configFile.activeIndex ? chalk.green(' ◀ last used') : '';
    const providerLabel = getProviderLabel(p.config.provider);
    console.log(`    ${i + 1}. ${chalk.white(p.name)} ${chalk.dim(`(${providerLabel})`)}${active}`);
  });
  console.log(`    ${configFile.profiles.length + 1}. ${chalk.yellow('+ Add new AI profile')}`);
  console.log(`    ${configFile.profiles.length + 2}. ${chalk.red('✖ Remove a profile')}`);
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const maxChoice = configFile.profiles.length + 2;
  const defaultChoice = configFile.activeIndex + 1;

  let choice = 0;
  while (choice === 0) {
    const answer = await askQuestion(rl, `  Choice [1-${maxChoice}] (Enter for ${defaultChoice}): `);

    // Enter with no input — use last active
    if (!answer) {
      choice = defaultChoice;
      break;
    }

    const num = parseInt(answer, 10);
    if (num >= 1 && num <= maxChoice) {
      choice = num;
    } else {
      console.log(`  Please enter a number between 1 and ${maxChoice}.`);
    }
  }

  rl.close();

  // Add new profile
  if (choice === configFile.profiles.length + 1) {
    return await promptForConfig();
  }

  // Remove a profile
  if (choice === configFile.profiles.length + 2) {
    await removeProfile(configFile);
    // After removal, re-run the picker
    return await promptForStartupConfig();
  }

  // Use selected profile
  const selectedIndex = choice - 1;
  configFile.activeIndex = selectedIndex;
  saveConfigFile(configFile);

  const selected = configFile.profiles[selectedIndex];
  console.log(chalk.green(`\n  ✓ Using: ${selected.name}\n`));
  return selected.config;
}

// ─── Remove Profile ─────────────────────────────────────────────────────────

async function removeProfile(configFile: ConfigFile): Promise<void> {
  if (configFile.profiles.length <= 1) {
    console.log(chalk.yellow('\n  Cannot remove the only profile.\n'));
    return;
  }

  console.log('\n  Which profile do you want to remove?\n');
  configFile.profiles.forEach((p, i) => {
    console.log(`    ${i + 1}. ${p.name}`);
  });
  console.log(`    ${configFile.profiles.length + 1}. Cancel`);
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const maxChoice = configFile.profiles.length + 1;
  let choice = 0;
  while (choice === 0) {
    const answer = await askQuestion(rl, `  Remove [1-${maxChoice}]: `);
    const num = parseInt(answer, 10);
    if (num >= 1 && num <= maxChoice) {
      choice = num;
    } else {
      console.log(`  Please enter a number between 1 and ${maxChoice}.`);
    }
  }

  rl.close();

  if (choice === maxChoice) {
    console.log('  Cancelled.');
    return;
  }

  const removeIdx = choice - 1;
  const removed = configFile.profiles.splice(removeIdx, 1)[0];
  console.log(chalk.red(`\n  ✖ Removed: ${removed.name}`));

  // Adjust activeIndex if needed
  if (configFile.activeIndex >= configFile.profiles.length) {
    configFile.activeIndex = configFile.profiles.length - 1;
  }

  saveConfigFile(configFile);
}

// ─── Model-Only Change ──────────────────────────────────────────────────────

export async function promptForModelChange(currentConfig: Config): Promise<Config> {
  const model = await selectModel(
    currentConfig.provider,
    currentConfig.baseURL,
    currentConfig.apiKey,
    currentConfig.model,
  );

  const updated: Config = { ...currentConfig, model };
  saveConfig(updated);
  console.log(`\n  ✓ Model updated: ${model}\n`);
  return updated;
}

// ─── Runtime Config Menu (used mid-session) ─────────────────────────────────

export async function promptForConfigMenu(currentConfig: Config): Promise<Config | null> {
  const providerLabel = getProviderLabel(currentConfig.provider);
  const configFile = loadConfigFile();
  const profileCount = configFile?.profiles.length ?? 1;

  console.log('\n  Current config:');
  console.log(`    Provider:  ${providerLabel}`);
  console.log(`    Model:     ${currentConfig.model}`);
  console.log('');
  console.log('  What do you want to change?');
  console.log('    1. Switch to a saved profile');
  console.log('    2. Add a new AI profile');
  console.log('    3. Change model only');
  console.log('    4. Cancel');
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let choice = 0;
  while (choice === 0) {
    const answer = await askQuestion(rl, '  Choice [1-4]: ');
    const num = parseInt(answer, 10);
    if (num >= 1 && num <= 4) {
      choice = num;
    } else {
      console.log('  Please enter a number between 1 and 4.');
    }
  }

  rl.close();

  switch (choice) {
    case 1: {
      // Show saved profiles to pick from
      if (!configFile || profileCount <= 1) {
        console.log(chalk.yellow('\n  No other profiles saved. Use "Add a new AI profile" instead.\n'));
        return null;
      }
      return await pickFromSavedProfiles(configFile, currentConfig);
    }
    case 2:
      return await promptForConfig();
    case 3:
      return await promptForModelChange(currentConfig);
    case 4:
    default:
      return null;
  }
}

// ─── Pick From Saved Profiles (mid-session) ─────────────────────────────────

async function pickFromSavedProfiles(configFile: ConfigFile, currentConfig: Config): Promise<Config | null> {
  console.log('');
  console.log(chalk.bold.cyan('  Saved profiles:\n'));

  configFile.profiles.forEach((p, i) => {
    const isCurrent =
      p.config.provider === currentConfig.provider && p.config.model === currentConfig.model;
    const marker = isCurrent ? chalk.green(' ◀ current') : '';
    const providerLabel = getProviderLabel(p.config.provider);
    console.log(`    ${i + 1}. ${chalk.white(p.name)} ${chalk.dim(`(${providerLabel})`)}${marker}`);
  });
  console.log(`    ${configFile.profiles.length + 1}. Cancel`);
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const maxChoice = configFile.profiles.length + 1;
  let choice = 0;
  while (choice === 0) {
    const answer = await askQuestion(rl, `  Choice [1-${maxChoice}]: `);
    const num = parseInt(answer, 10);
    if (num >= 1 && num <= maxChoice) {
      choice = num;
    } else {
      console.log(`  Please enter a number between 1 and ${maxChoice}.`);
    }
  }

  rl.close();

  if (choice === maxChoice) return null;

  const selectedIndex = choice - 1;
  configFile.activeIndex = selectedIndex;
  saveConfigFile(configFile);

  const selected = configFile.profiles[selectedIndex];
  console.log(chalk.green(`\n  ✓ Switched to: ${selected.name}\n`));
  return selected.config;
}
