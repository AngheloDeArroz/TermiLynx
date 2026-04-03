import type { Config } from './config.js';
import type { ToolDefinition } from './tools/index.js';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
}

export class LLMError extends Error {
  public readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'LLMError';
    this.statusCode = statusCode;
  }
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIChatChoice {
  message: {
    role: string;
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: string;
}

interface OpenAIChatResponse {
  choices: OpenAIChatChoice[];
  error?: {
    message: string;
    type: string;
  };
}

function formatToolsForAPI(tools: ToolDefinition[]): object[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export async function callLLM(
  config: Config,
  messages: LLMMessage[],
  tools?: ToolDefinition[],
): Promise<LLMResponse> {
  const url = `${config.baseURL}/chat/completions`;

  const body: Record<string, unknown> = {
    model: config.model,
    messages: messages.map((m) => {
      const msg: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.tool_call_id) {
        msg.tool_call_id = m.tool_call_id;
      }
      // Forward tool_calls on assistant messages so the API can match
      // subsequent tool-role messages to their originating call IDs
      const extended = m as unknown as Record<string, unknown>;
      if (extended.tool_calls) {
        msg.tool_calls = extended.tool_calls;
      }
      return msg;
    }),
  };

  if (tools && tools.length > 0) {
    body.tools = formatToolsForAPI(tools);
    body.tool_choice = 'auto';
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000), // 2 minute timeout
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new LLMError('Request to LLM API timed out after 120s');
    }
    throw new LLMError(
      `Failed to connect to ${config.baseURL}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
    try {
      const errorBody = await response.text();
      // Try to extract a meaningful error message
      const parsed: unknown = JSON.parse(errorBody);
      if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
        const errObj = (parsed as Record<string, unknown>).error;
        if (typeof errObj === 'object' && errObj !== null && 'message' in errObj) {
          errorMessage = (errObj as Record<string, string>).message;
        } else if (typeof errObj === 'string') {
          errorMessage = errObj;
        }
      }
    } catch {
      // Use default error message
    }
    throw new LLMError(errorMessage, response.status);
  }

  let data: OpenAIChatResponse;
  try {
    data = (await response.json()) as OpenAIChatResponse;
  } catch {
    throw new LLMError('Failed to parse JSON response from LLM API');
  }

  if (data.error) {
    throw new LLMError(data.error.message);
  }

  if (!data.choices || data.choices.length === 0) {
    throw new LLMError('LLM API returned no choices');
  }

  const choice = data.choices[0];
  const result: LLMResponse = {
    content: choice.message.content || '',
  };

  if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
    result.toolCalls = choice.message.tool_calls.map((tc) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        // If arguments fail to parse, pass empty object
      }
      return {
        id: tc.id,
        name: tc.function.name,
        arguments: args,
      };
    });
  }

  return result;
}
