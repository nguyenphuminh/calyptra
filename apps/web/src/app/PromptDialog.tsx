import { nicknames, peerName, RequestAnswer, RequestDetails, requestTerms, useSecondsLeft, type ChannelRequest } from '../modules/channels/index.ts';
import { tokenName } from '../shared/amounts.ts';
import { Button, Modal, Money } from '../shared/ui.tsx';
import { useApp } from './context.ts';
import type { Asked, Prompt } from './prompts.ts';

/** The wallet's own dialog for the question the framework asks right now. */
export function PromptDialog({ asked }: { asked: Asked }) {
  const { prompts } = useApp();
  const { prompt } = asked;
  return prompt.kind === 'confirm-payment'
    ? <ConfirmPayment prompt={prompt} onAnswer={(answer) => prompts.answer(asked.id, answer)} />
    : <ApproveOpen key={asked.id} asked={{ ...asked, prompt }} />;
}

/** No outgoing payment is signed without the user's confirmation. No close button: the user must choose. */
function ConfirmPayment({ prompt, onAnswer }: { prompt: Extract<Prompt, { kind: 'confirm-payment' }>; onAnswer: (answer: boolean) => void }) {
  const { calyptra } = useApp();
  const peerId = calyptra.channels.get(prompt.channelId).peer.peerId;
  return (
    <Modal title="Confirm payment">
      <p>Pay <strong><Money token={tokenName(prompt.token)} value={prompt.amount} /></strong> to {peerName(peerId, nicknames(calyptra))} in your tab?</p>
      <div className="stack">
        <Button className="primary wide" onClick={() => onAnswer(true)}>Confirm payment</Button>
        <Button className="ghost wide" onClick={() => onAnswer(false)}>Cancel</Button>
      </div>
    </Modal>
  );
}

/** A tab that asks for the user's money needs approval; closing the dialog answers nothing. */
function ApproveOpen({ asked }: { asked: ChannelRequest }) {
  const { prompts } = useApp();
  const { request } = asked.prompt;
  const secondsLeft = useSecondsLeft(asked.deadline);
  return (
    <Modal title="Tab request" onClose={() => prompts.hide(asked.id)}>
      <p>Someone with your invite wants to start a tab with you. {requestTerms(request)}.</p>
      <p>Fee to settle: <Money token={tokenName(request.token)} value={request.closingFee} /> (paid by them)</p>
      <RequestDetails request={request} />
      <p className="muted small">{secondsLeft} s left to answer. You can close this and answer from Tabs.</p>
      <RequestAnswer asked={asked} />
    </Modal>
  );
}
