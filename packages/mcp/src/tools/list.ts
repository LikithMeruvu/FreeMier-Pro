import { COMMANDS as TOOLS } from '@freemier/service';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export async function listTools() {
  return {
    tools: TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: zodToJsonSchema(z.object(t.inputSchema), {
        target: 'jsonSchema7',
        $refStrategy: 'none',
      }) as Record<string, unknown>,
    })),
  };
}
