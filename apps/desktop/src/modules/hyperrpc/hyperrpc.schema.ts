import { z } from 'zod';

/** One JSON-RPC 2.0 request, as the framework's chain adapter sends it. */
export const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1),
  params: z.array(z.unknown()).optional(),
});
export type JsonRpcRequest = z.output<typeof jsonRpcRequestSchema>;

/** The `eth_getLogs` filter field the proxy checks; the rest of the filter is forwarded untouched. */
export const logFilterSchema = z.object({ address: z.union([z.string(), z.array(z.string())]).optional() });
