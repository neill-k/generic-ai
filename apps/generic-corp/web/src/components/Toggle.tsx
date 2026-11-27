/** A labelled checkbox row for settings pages. */
export function Toggle({
  checked,
  label,
  hint,
  onChange,
  disabled,
}: {
  checked: boolean;
  label: string;
  hint?: string;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label class="toggle">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange((event.target as HTMLInputElement).checked)}
      />
      <span>
        <strong>{label}</strong>
        {hint === undefined ? null : <span class="small muted"> {hint}</span>}
      </span>
    </label>
  );
}

export const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
