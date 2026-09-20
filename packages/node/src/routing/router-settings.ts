import type { ConfigField } from '../interfaces/plugin.js';

export type RouterSettingField = Omit<ConfigField, 'type' | 'default' | 'required'> & {
  type: Extract<ConfigField['type'], 'string' | 'number' | 'boolean'>;
  default?: string;
};

export function readRouterSettings(value: unknown): Record<string, Record<string, string>> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Router settings must be an object');
  const entries = Object.entries(value);
  if (entries.length > 100) throw new Error('Too many router settings namespaces');
  return Object.fromEntries(entries.map(([namespace, settings]) => {
    if (namespace === 'plugin:classifier' || namespace === 'plugin:@antseed/router-classifier') throw new Error('Classifier settings are obsolete. Configure buyer.selection.preferences using the selected router metadata schema.');
    if (!/^(plugin|instance):[^\s]{1,200}$/.test(namespace) || !settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error('Invalid router settings namespace');
    }
    const fields = Object.entries(settings);
    if (fields.length > 50 || fields.some(([key, item]) => !/^[a-zA-Z][\w.-]{0,79}$/.test(key)
      || typeof item !== 'string' || item.length > 4096)) throw new Error('Invalid router settings values');
    return [namespace, Object.fromEntries(fields) as Record<string, string>];
  }));
}

export function validateRouterSettings(schema: readonly RouterSettingField[], values: Record<string, string>): Record<string, string> {
  for (const [key, value] of Object.entries(values)) {
    const field = schema.find((entry) => entry.key === key);
    if (!field) throw new Error(`Unknown router setting: ${key}`);
    if (field.options && !field.options.includes(value)) throw new Error(`Invalid router setting: ${key}`);
    if (field.type === 'boolean' && value !== 'true' && value !== 'false') throw new Error(`Invalid router setting: ${key}`);
    if (field.type === 'number' && (value.trim() === '' || !Number.isFinite(Number(value))
      || (field.min !== undefined && Number(value) < field.min)
      || (field.max !== undefined && Number(value) > field.max))) throw new Error(`Invalid router setting: ${key}`);
  }
  return { ...values };
}
