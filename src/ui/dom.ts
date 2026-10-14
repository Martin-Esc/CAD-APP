/** Tiny DOM helpers – the UI is plain TypeScript, no framework. */

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') node.className = String(v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}

export function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  return el('button', { class: `btn ${cls}`.trim(), type: 'button', onclick: () => onClick() }, label);
}

export function section(title: string, ...children: (Node | null)[]): HTMLElement {
  return el('section', { class: 'panel-section' }, el('h3', {}, title), ...children);
}

export function numberField<T extends object>(
  label: string,
  obj: T,
  key: keyof T & string,
  opts: { min?: number; max?: number; step?: number; unit?: string; onChange?: () => void } = {},
): HTMLElement {
  const input = el('input', {
    type: 'number',
    value: String(obj[key]),
    min: opts.min,
    max: opts.max,
    step: opts.step ?? 0.1,
  });
  input.addEventListener('change', () => {
    let v = Number(input.value);
    if (!Number.isFinite(v)) return;
    if (opts.min !== undefined) v = Math.max(opts.min, v);
    if (opts.max !== undefined) v = Math.min(opts.max, v);
    input.value = String(v);
    (obj as Record<string, unknown>)[key] = v;
    opts.onChange?.();
  });
  return el('label', { class: 'field' }, el('span', {}, label), el('span', { class: 'input-unit' }, input, opts.unit ? el('small', {}, opts.unit) : null));
}

export function selectField<T extends object>(
  label: string,
  obj: T,
  key: keyof T & string,
  options: [string, string][],
  onChange?: () => void,
): HTMLElement {
  const select = el('select', {});
  for (const [value, text] of options) {
    select.append(el('option', { value, selected: String(obj[key]) === value }, text));
  }
  select.addEventListener('change', () => {
    (obj as Record<string, unknown>)[key] = select.value;
    onChange?.();
  });
  return el('label', { class: 'field' }, el('span', {}, label), select);
}

export function checkboxField<T extends object>(label: string, obj: T, key: keyof T & string, onChange?: () => void): HTMLElement {
  const input = el('input', { type: 'checkbox', checked: Boolean(obj[key]) });
  input.addEventListener('change', () => {
    (obj as Record<string, unknown>)[key] = input.checked;
    onChange?.();
  });
  return el('label', { class: 'field checkbox' }, el('span', {}, label), input);
}

export function textField<T extends object>(label: string, obj: T, key: keyof T & string, multiline = false): HTMLElement {
  const input = multiline ? el('textarea', { rows: 3 }) : el('input', { type: 'text' });
  input.value = String(obj[key] ?? '');
  input.addEventListener('input', () => ((obj as Record<string, unknown>)[key] = input.value));
  return el('label', { class: 'field' }, el('span', {}, label), input);
}

export function note(text: string, kind: 'info' | 'warn' | 'error' = 'info'): HTMLElement {
  return el('div', { class: `note ${kind}` }, text);
}
