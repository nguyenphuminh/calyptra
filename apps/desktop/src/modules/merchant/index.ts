import type { Calyptra, Offer, ServicePort } from '@calyptra/framework';
import { QwenAdapter } from './adapters/qwen.adapter.ts';
import { MerchantCardService } from './merchant.service.ts';
import { QwenChatService } from './qwen-chat.service.ts';

export type { MerchantCardService } from './merchant.service.ts';

/** The service this merchant sells: an AI chat on Qwen (key from DASHSCOPE_API_KEY). */
export function createQwenService(apiKey: string): ServicePort {
  return new QwenChatService(new QwenAdapter({ apiKey }));
}

export function createMerchantCardService(calyptra: Calyptra, offer: Offer): MerchantCardService {
  return new MerchantCardService(calyptra, offer);
}
