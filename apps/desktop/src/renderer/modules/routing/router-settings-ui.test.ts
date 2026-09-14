import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { RouterSettings } from '../../ui/components/chat/RouterSettings';

test('renders only the selected plugin schema, including its own vocabulary', () => {
  const html = renderToStaticMarkup(createElement(RouterSettings, { schema: [
    { key: 'policy', label: 'Classifier policy', type: 'string', options: ['fast', 'accurate'], default: 'fast' },
    { key: 'strict', label: 'Strict classification', type: 'boolean' },
  ], values: { policy: 'accurate', strict: 'true' }, onChange: () => {} }));
  expect(html).toContain('Classifier policy');
  expect(html).toContain('selected=""');
  expect(html).toContain('checked=""');
  expect(html).not.toContain('Cost / quality');
});

test('routers with no settings render no synthetic universal control', () => {
  expect(renderToStaticMarkup(createElement(RouterSettings, { schema: [], values: {}, onChange: () => {} }))).toBe('<div></div>');
});
