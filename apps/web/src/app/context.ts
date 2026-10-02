import type { Calyptra } from '@calyptra/framework';
import { createContext, useContext } from 'react';
import type { PendingOpens } from '../modules/channels/index.ts';
import type { Prompts } from './prompts.ts';

export interface AppContextValue {
  calyptra: Calyptra;
  prompts: Prompts;
  pendingOpens: PendingOpens; // channels being opened from this tab, shown while the other side decides
  version: number; // changes whenever wallet data may have changed (after an action or a background check)
  refresh: () => void;
  lock: () => Promise<void>;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp outside the unlocked app');
  return value;
}
