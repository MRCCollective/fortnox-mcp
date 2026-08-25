import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  RegisteredTool,
  ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  AnySchema,
  ZodRawShapeCompat,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import {
  MCP_ACCESS_MODES,
  type McpAccessMode,
} from "../accessMode.js";
import { registerCustomerTools } from "../tools/customers.js";
import { registerInvoiceTools } from "../tools/invoices.js";
import { registerSupplierTools } from "../tools/suppliers.js";
import { registerAccountTools } from "../tools/accounts.js";
import { registerVoucherTools } from "../tools/vouchers.js";
import { registerCompanyTools } from "../tools/company.js";
import { registerAnalyticsTools } from "../tools/analytics.js";
import { registerSupplierInvoiceTools } from "../tools/supplierInvoices.js";
import { registerOrderTools } from "../tools/orders.js";
import { registerBIAnalyticsTools } from "../tools/biAnalytics.js";

interface ToolConfig<
  InputArgs extends undefined | ZodRawShapeCompat | AnySchema,
  OutputArgs extends ZodRawShapeCompat | AnySchema,
> {
  title?: string;
  description?: string;
  inputSchema?: InputArgs;
  outputSchema?: OutputArgs;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
}

class AccessControlledMcpServer extends McpServer {
  constructor(private readonly accessMode: McpAccessMode) {
    super({
      name: "fortnox-mcp-server",
      version: "1.0.1",
    });
  }

  override registerTool<
    OutputArgs extends ZodRawShapeCompat | AnySchema,
    InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
  >(
    name: string,
    config: ToolConfig<InputArgs, OutputArgs>,
    cb: ToolCallback<InputArgs>
  ): RegisteredTool {
    const tool = super.registerTool(name, config, cb);

    if (
      this.accessMode === MCP_ACCESS_MODES.READ_ONLY &&
      config.annotations?.readOnlyHint !== true
    ) {
      tool.disable();
    }

    return tool;
  }
}

export function createFortnoxMcpServer(accessMode: McpAccessMode): McpServer {
  const server = new AccessControlledMcpServer(accessMode);

  registerCustomerTools(server);
  registerInvoiceTools(server);
  registerSupplierTools(server);
  registerSupplierInvoiceTools(server);
  registerAccountTools(server);
  registerVoucherTools(server);
  registerCompanyTools(server);
  registerAnalyticsTools(server);
  registerOrderTools(server);
  registerBIAnalyticsTools(server);

  return server;
}
