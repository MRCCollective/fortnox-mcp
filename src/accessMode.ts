export const MCP_ACCESS_MODES = {
  READ_ONLY: "read-only",
  READ_WRITE: "read-write",
} as const;

export type McpAccessMode = typeof MCP_ACCESS_MODES[keyof typeof MCP_ACCESS_MODES];

export const DEFAULT_MCP_ACCESS_MODE: McpAccessMode = MCP_ACCESS_MODES.READ_WRITE;

export function parseMcpAccessMode(value: string | undefined): McpAccessMode {
  if (value === undefined) {
    return DEFAULT_MCP_ACCESS_MODE;
  }

  if (value === MCP_ACCESS_MODES.READ_ONLY || value === MCP_ACCESS_MODES.READ_WRITE) {
    return value;
  }

  throw new Error(
    `Invalid MCP_ACCESS_MODE "${value}". Expected "read-only" or "read-write".`
  );
}

export function getMcpAccessMode(): McpAccessMode {
  return parseMcpAccessMode(process.env.MCP_ACCESS_MODE);
}

export function assertFortnoxRequestAllowed(
  method: "GET" | "POST" | "PUT" | "DELETE",
  accessMode: McpAccessMode = getMcpAccessMode()
): void {
  if (accessMode === MCP_ACCESS_MODES.READ_ONLY && method !== "GET") {
    throw new Error(
      `Fortnox ${method} request blocked by MCP_ACCESS_MODE=read-only`
    );
  }
}
