/**
 * llm/schema.ts
 * ---------------------------------------------------------------------------
 * The same tool, three dialects.
 *
 *   Anthropic : { name, description, input_schema }
 *   OpenAI    : { type: 'function', function: { name, description, parameters } }
 *   Gemini    : { functionDeclarations: [{ name, description, parameters }] }
 *
 * The interesting part is Gemini. Its `Schema` type is a subset of OpenAPI 3.0,
 * NOT JSON Schema:
 *   - `type` must be UPPERCASE ("STRING", "OBJECT", ...)
 *   - `additionalProperties`, `$schema`, `default` and `exclusiveMinimum` are
 *     rejected outright with a 400
 *   - an object with zero properties is also rejected, so no-argument tools
 *     must omit `parameters` entirely
 * ---------------------------------------------------------------------------
 */

import type { JsonSchema, JsonSchemaProperty, ToolDefinition } from '../types.js';

/* ------------------------------------------------------------------ Anthropic */

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

export function toAnthropicTools(tools: ToolDefinition[]): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    // Anthropic accepts standard JSON Schema as-is.
    input_schema: t.parameters,
  }));
}

/* --------------------------------------------------------------------- OpenAI */

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

export function toOpenAITools(tools: ToolDefinition[]): OpenAITool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/* --------------------------------------------------------------------- Gemini */

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: GeminiSchema;
}

export interface GeminiSchema {
  type: string;
  description?: string;
  format?: string;
  enum?: string[];
  items?: GeminiSchema;
  properties?: Record<string, GeminiSchema>;
  required?: string[];
  nullable?: boolean;
}

export function toGeminiTools(
  tools: ToolDefinition[],
): [{ functionDeclarations: GeminiFunctionDeclaration[] }] {
  return [
    {
      functionDeclarations: tools.map((t) => {
        const hasProps = Object.keys(t.parameters.properties).length > 0;
        const decl: GeminiFunctionDeclaration = {
          name: t.name,
          description: t.description,
        };
        // Gemini 400s on an OBJECT schema with an empty `properties` map.
        if (hasProps) decl.parameters = geminiSchema(t.parameters);
        return decl;
      }),
    },
  ];
}

function geminiSchema(schema: JsonSchema | JsonSchemaProperty): GeminiSchema {
  const out: GeminiSchema = { type: geminiType(schema.type) };

  if (schema.description) out.description = schema.description;
  if ('enum' in schema && schema.enum) out.enum = schema.enum;

  if ('properties' in schema && schema.properties) {
    const props: Record<string, GeminiSchema> = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      props[key] = geminiSchema(value);
    }
    out.properties = props;
  }

  if ('items' in schema && schema.items) out.items = geminiSchema(schema.items);
  if ('required' in schema && schema.required?.length) out.required = [...schema.required];

  // `additionalProperties` and `default` are deliberately dropped here.
  return out;
}

function geminiType(type: string): string {
  switch (type) {
    case 'string':
      return 'STRING';
    case 'number':
      return 'NUMBER';
    case 'integer':
      return 'INTEGER';
    case 'boolean':
      return 'BOOLEAN';
    case 'array':
      return 'ARRAY';
    case 'object':
    default:
      return 'OBJECT';
  }
}
