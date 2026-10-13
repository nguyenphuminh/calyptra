import { TOKEN_CHOICES, TOKEN_LABEL, type TokenName } from '../../shared/amounts.ts';
import { Field } from '../../shared/ui.tsx';

/** The currency of a form: dollars (AUSD) first, the default, then MON. */
export function TokenSelect({ value, onChange }: { value: TokenName; onChange: (token: TokenName) => void }) {
  return (
    <Field label="Currency">
      <select value={value} onChange={(e) => onChange(e.target.value as TokenName)}>
        {TOKEN_CHOICES.map((t) => <option key={t} value={t}>{TOKEN_LABEL[t]}</option>)}
      </select>
    </Field>
  );
}
