import { z } from 'zod';

/** One JSON-RPC 2.0 request, as the framework's chain adapter sends it. */
export const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1),
  params: z.array(z.unknown()).optional(),
});
export type JsonRpcRequest = z.output<typeof jsonRpcRequestSchema>;

/** The `eth_getLogs` filter field the allow-list checks (the refusal does not depend on the rest). */
export const logFilterSchema = z.object({ address: z.union([z.string(), z.array(z.string())]).optional() });

/** A JSON-RPC quantity, e.g. a block number: "0x" and hex digits. */
export const quantitySchema = z.string().regex(/^0x[0-9a-fA-F]+$/);
const topicSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

/** The whole `eth_getLogs` filter the cache answers (standard JSON-RPC; `blockHash` is recognised to be refused). */
export const getLogsFilterSchema = z.object({
  address: z.union([z.string(), z.array(z.string())]),
  fromBlock: z.union([z.enum(['earliest', 'latest', 'pending', 'safe', 'finalized']), quantitySchema]).optional(),
  toBlock: z.union([z.enum(['earliest', 'latest', 'pending', 'safe', 'finalized']), quantitySchema]).optional(),
  /** Positional: null matches anything, an array matches any of its topics. */
  topics: z.array(z.union([topicSchema, z.array(topicSchema.nullable()), z.null()])).max(4).optional(),
  blockHash: z.string().optional(),
});
export type GetLogsFilter = z.output<typeof getLogsFilterSchema>;

/** One log as the upstream returns it: the fields the cache reads are checked, every field is kept. */
export const upstreamLogSchema = z.looseObject({
  address: z.string(),
  topics: z.array(z.string()),
  blockNumber: quantitySchema,
  logIndex: quantitySchema,
});
export type UpstreamLog = z.output<typeof upstreamLogSchema>;
