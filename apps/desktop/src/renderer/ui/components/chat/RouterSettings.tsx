import type { RouterSettingField } from '@antseed/node/router-settings';

export function RouterSettings({ schema, values, onChange }: {
  schema: RouterSettingField[];
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}) {
  return <div>{schema.map((field) => {
    const value = values[field.key] ?? field.default ?? '';
    const update = (next: string) => onChange({ ...values, [field.key]: next });
    return <label key={field.key} style={{ display: 'grid', gap: 6, marginBlock: 12 }}>
      <span>{field.label}</span>
      {field.description ? <small>{field.description}</small> : null}
      {field.options ? <select aria-label={field.label} value={value} onChange={(event) => update(event.target.value)}>
        {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select> : field.type === 'boolean' ? <input aria-label={field.label} type="checkbox" checked={value === 'true'}
        onChange={(event) => update(String(event.target.checked))} />
        : <input aria-label={field.label} type={field.type === 'number' ? 'number' : 'text'}
          value={value} min={field.min} max={field.max} maxLength={4096}
          onChange={(event) => update(event.target.value)} />}
    </label>;
  })}</div>;
}
