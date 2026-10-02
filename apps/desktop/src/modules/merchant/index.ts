import type { Calyptra, Offer } from '@calyptra/framework';
import { QwenAdapter } from './adapters/qwen.adapter.ts';
import { MerchantHost } from './merchant.service.ts';
import { QwenChatService } from './qwen-chat.service.ts';

export type { MerchantHost } from './merchant.service.ts';

/** The merchant of this node: the offer, sold as an AI chat on Qwen (key from DASHSCOPE_API_KEY). */
export function createQwenMerchant(calyptra: Calyptra, offer: Offer, apiKey: string): MerchantHost {
  return new MerchantHost(calyptra, offer, new QwenChatService(new QwenAdapter({ apiKey })));
}
