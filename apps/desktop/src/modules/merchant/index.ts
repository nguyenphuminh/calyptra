import type { Calyptra, Offer, ServicePort } from '@calyptra/framework';
import { GeminiAdapter } from './adapters/gemini.adapter.ts';
import { GeminiChatService } from './gemini-chat.service.ts';
import { MerchantCardService } from './merchant.service.ts';

export type { MerchantCardService } from './merchant.service.ts';

/** The service this merchant sells: an AI chat on Gemini (key from GEMINI_API_KEY). */
export function createGeminiService(apiKey: string): ServicePort {
  return new GeminiChatService(new GeminiAdapter({ apiKey }));
}

export function createMerchantCardService(calyptra: Calyptra, offer: Offer): MerchantCardService {
  return new MerchantCardService(calyptra, offer);
}
