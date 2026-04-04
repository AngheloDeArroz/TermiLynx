# OpenMerlin-CLI

OpenMerlin-CLI is a terminal-first coding agent for real project folders. It connects to an LLM provider, scans your codebase for context, and executes tool calls with explicit safety confirmations for writes and shell commands.
                                
## What It Does

- Runs as a local CLI coding assistant
- Uses OpenAI-compatible chat completions (`/chat/completions`)
- Supports multi-profile provider setup and switching
- Scans project structure, `package.json`, and `README.md` for context
- Calls tools for reading, searching, writing files, and running commands
- Generates an approval plan for complex tasks

## Requirements

- Node.js >= 18
- npm

## Installation

```bash
git clone <repo-url>
cd OpenMerlin-CLI
npm install
npm run build
npm link
```

Then run from any project directory:

```bash
openmerlin
```

## First Run and Configuration

OpenMerlin-CLI launches an interactive setup that creates provider/model profiles.

Built-in providers:

- OpenAI
- Anthropic
- Google Gemini
- Groq
- OpenRouter
- Ollama (local)

Config location:

- macOS/Linux: `~/.myagent/config.json`
- Windows: `%USERPROFILE%\\.myagent\\config.json`

Notes:

- Multiple profiles are supported with an active profile index.
- Existing legacy single-profile config is migrated automatically at load time.
- Key input is masked in supported terminals.

## Usage

Start in a project folder:

```bash
cd path/to/project
openmerlin
```

Run in development mode:

```bash
npm run dev
```

Common prompts you can type:

- "find all TODOs in src"
- "add error handling to functions in src/api.ts"
- "explain how auth works in this repo"
- "run tests and summarize failures"

## Built-in CLI Commands

- `help`: Show command help
- `config`: Open runtime config menu
- `model` or `switch`: Switch provider/model profile
- `clear`: Clear conversation history
- `exit` or `quit`: Exit the app

## Tool System

Registered tools:

- `read_file`: Read a file relative to project root
- `write_file`: Show diff and ask confirmation before write
- `list_files`: Show directory tree (depth-limited)
- `search_code`: Search text across project files
- `run_command`: Execute shell command after safety check + confirmation

## Safety Model

- File access is restricted to paths inside the active project root.
- `write_file` always asks for explicit confirmation.
- `run_command` always asks for explicit confirmation.
- Dangerous command patterns are blocked before execution.
- Shell execution has a 30-second timeout and 1 MB output buffer.

## Architecture Overview

```text
src/
  index.ts         # CLI bootstrap and prompt loop
  config.ts        # Profile setup, save/load, switching
  scanner.ts       # Project structure + metadata summarization
  agent.ts         # Main LLM loop and tool-call execution
  llm.ts           # OpenAI-compatible HTTP API client
  planner.ts       # Plan generation and user approval
  safety.ts        # Path safety and dangerous command rules
  output.ts        # Terminal UI and formatting
  tools/
    index.ts       # Tool registration and dispatch
    listFiles.ts
    readFile.ts
    runCommand.ts
    searchCode.ts
    writeFile.ts
```

## Development

```bash
npm run dev
npm run build
npm start
```

`npm run build` compiles TypeScript into `dist/` and `npm start` runs the compiled CLI.

## Open Source Contribution Plan

This is the execution plan for making contributions easy and consistent.

### Phase 1: Repository Foundations

- Add `LICENSE` file (MIT)
- Add `CONTRIBUTING.md`
- Add PR template and issue templates
- Add a simple `CODE_OF_CONDUCT.md`

### Phase 2: Quality and Reliability

- Add unit tests for `safety.ts`
- Add tests for tool parameter validation and error handling
- Add integration tests for approval flows (`write_file`, `run_command`)
- Add CI workflow for build/test on Windows + Linux + macOS

### Phase 3: Product Improvements

- Improve malformed tool-call recovery in LLM responses
- Add stronger provider diagnostics (401/403/timeout guidance)
- Add optional streaming output mode
- Add conversation/session export

### Phase 4: Contributor Experience

- Tag and maintain `good first issue` tasks
- Keep docs updated with each behavior change
- Require focused PR scope (single concern per PR)

## How to Contribute

1. Fork and clone.
2. Create a feature branch.
3. Install dependencies with `npm install`.
4. Validate with `npm run build`.
5. Test manually using `npm run dev` in a sample project.
6. Open a PR describing changes, reasoning, and validation steps.

## Good First Issues

- Add `LICENSE` file in root
- Add `CONTRIBUTING.md`
- Add tests for dangerous command pattern coverage
- Improve command help output examples
- Add docs for profile migration behavior

## License

MIT (declared in `package.json`).
