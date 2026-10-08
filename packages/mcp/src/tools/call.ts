import { COMMANDS as TOOLS, type CommandContext } from '@freemier/service';
import { EditorError, serializeError } from '@freemier/shared';
import { z } from 'zod';

export async function callTool(request: { params: { name: string; arguments?: Record<string, unknown> } }, context: CommandContext) {
  const { name, arguments: rawArgs } = request.params;
  const tool = TOOLS.find((t) => t.name === name);

  if (!tool) {
    return {
      isError: true,
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: false,
          error: { code: 'NOT_FOUND', message: `Unknown tool: ${name}`, details: { available: TOOLS.map((t) => t.name) } },
        }),
      }],
    };
  }

  const parsed = z.object(tool.inputSchema).safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return {
      isError: true,
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: false,
          error: {
            code: 'INVALID_ARGUMENT',
            message: `Invalid arguments for ${name}`,
            details: { issues: parsed.error.issues },
          },
        }),
      }],
    };
  }

  try {
    const result = await tool.handler(parsed.data as Record<string, unknown>, context);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    // Never leak a stack trace across the boundary — agents act on codes.
    const serialized = serializeError(err);
    if (!(err instanceof EditorError)) {
      process.stderr.write(`[freemier-pro] ${name} failed: ${serialized.message}\n`);
    }
    return {
      isError: true,
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: serialized }) }],
    };
  }
}
