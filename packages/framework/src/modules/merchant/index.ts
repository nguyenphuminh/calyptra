export { MerchantService } from './merchant.service.ts';
export type { GateStatus, MerchantDeps } from './merchant.service.ts';
export { EchoServicePort } from './merchant.port.ts';
export type { ServicePort } from './merchant.port.ts';
export { ServedClock, gateOpen, paidSecondsOf } from './merchant.gate.ts';
export {
  MAX_PROMPT_LENGTH,
  MerchantCardSchema,
  MerchantMessageSchema,
  OfferSchema,
  SERVICE_PROTOCOL,
  SubscriberMessageSchema,
  decodeMerchantCard,
  encodeMerchantCard,
  merchantLink,
  offerTokenOf,
} from './merchant.schema.ts';
export type { MerchantCard, MerchantMessage, Offer, SubscriberMessage } from './merchant.schema.ts';
