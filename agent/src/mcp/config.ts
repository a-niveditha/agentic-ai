import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

export const McpServerConfigSchema = z
  .object({
    transport: z.enum(['stdio', 'http']).default('stdio'),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).optional(),
    url: z.string().url().optional(),
    headers: z.record(z.string()).optional(),
    /** Scopes a caller needs for this server's tools. Operators grant 'mcp' to trusted users only. */
    requiredScopes: z.array(z.string()).default(['mcp']),
    toolTimeoutMs: z.number().int().positive().default(30_000),
  })
  .refine((c) => (c.transport === 'stdio' ? Boolean(c.command) : Boolean(c.url)), {
    message: "stdio servers need 'command'; http servers need 'url'",
  });

export const McpConfigSchema = z.object({
  servers: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/, 'server names may only contain letters, digits, _ and -'), McpServerConfigSchema).default({}),
});

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;

/** Reads mcp.config.json (operator-controlled, never user input). A missing file means "no MCP servers". */
export function loadMcpConfig(path: string | undefined): McpConfig {
  if (!path || !existsSync(path)) return { servers: {} };
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return McpConfigSchema.parse(raw);
}
