import { readFileTool } from './readFile.js';
import { writeFileTool } from './writeFile.js';
import { listFilesTool } from './listFiles.js';
import { searchCodeTool } from './searchCode.js';
import { runCommandTool } from './runCommand.js';

export interface ToolParameter {
  type: string;
  description: string;
  enum?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required: string[];
  };
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface Tool {
  definition: ToolDefinition;
  execute(params: Record<string, unknown>, projectRoot: string): Promise<ToolResult>;
}

const toolRegistry: Map<string, Tool> = new Map();

function registerTool(tool: Tool): void {
  toolRegistry.set(tool.definition.name, tool);
}

// Register all built-in tools
registerTool(readFileTool);
registerTool(writeFileTool);
registerTool(listFilesTool);
registerTool(searchCodeTool);
registerTool(runCommandTool);

export function getToolDefinitions(): ToolDefinition[] {
  return Array.from(toolRegistry.values()).map((t) => t.definition);
}

const READ_ONLY_TOOLS = new Set(['read_file', 'list_files', 'search_code']);

export function getReadOnlyToolDefinitions(): ToolDefinition[] {
  return Array.from(toolRegistry.values())
    .filter((t) => READ_ONLY_TOOLS.has(t.definition.name))
    .map((t) => t.definition);
}

export async function executeTool(
  name: string,
  params: Record<string, unknown>,
  projectRoot: string,
): Promise<ToolResult> {
  const tool = toolRegistry.get(name);
  if (!tool) {
    return { success: false, output: '', error: `Unknown tool: ${name}` };
  }
  try {
    return await tool.execute(params, projectRoot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, output: '', error: message };
  }
}
