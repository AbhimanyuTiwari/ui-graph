import { describe, expect, it } from 'vitest';
import { renderPlaywright, renderSelectorList } from '../../src/core/render';
import type { LocatorDescriptor } from '../../src/types';

describe('renderPlaywright', () => {
  it('renders role with name', () => {
    expect(renderPlaywright({ strategy: 'role', role: 'button', name: 'Save' })).toBe(
      "page.getByRole('button', { name: 'Save' })",
    );
  });

  it('renders role without name', () => {
    expect(renderPlaywright({ strategy: 'role', role: 'navigation' })).toBe(
      "page.getByRole('navigation')",
    );
  });

  it('renders role with nameRegex as a regex literal', () => {
    expect(
      renderPlaywright({ strategy: 'role', role: 'listitem', nameRegex: '\\d+ items? left' }),
    ).toBe("page.getByRole('listitem', { name: /\\d+ items? left/ })");
  });

  it('escapes forward slashes in regex sources', () => {
    expect(renderPlaywright({ strategy: 'text', nameRegex: 'a/b' })).toBe(
      'page.getByText(/a\\/b/)',
    );
  });

  it('renders label', () => {
    expect(renderPlaywright({ strategy: 'label', name: 'Email' })).toBe(
      "page.getByLabel('Email')",
    );
  });

  it('renders label with nameRegex', () => {
    expect(renderPlaywright({ strategy: 'label', nameRegex: 'Email.*' })).toBe(
      'page.getByLabel(/Email.*/)',
    );
  });

  it('renders placeholder', () => {
    expect(renderPlaywright({ strategy: 'placeholder', name: 'Search users' })).toBe(
      "page.getByPlaceholder('Search users')",
    );
  });

  it('renders text', () => {
    expect(renderPlaywright({ strategy: 'text', name: 'Welcome back' })).toBe(
      "page.getByText('Welcome back')",
    );
  });

  it('renders attr as an attribute selector', () => {
    expect(
      renderPlaywright({ strategy: 'attr', attr: { name: 'formcontrolname', value: 'email' } }),
    ).toBe('page.locator(\'[formcontrolname="email"]\')');
  });

  it('renders css', () => {
    expect(renderPlaywright({ strategy: 'css', css: '.toolbar > button.primary' })).toBe(
      "page.locator('.toolbar > button.primary')",
    );
  });

  it('escapes single quotes in names', () => {
    expect(renderPlaywright({ strategy: 'role', role: 'button', name: "Don't save" })).toBe(
      "page.getByRole('button', { name: 'Don\\'t save' })",
    );
  });

  it('escapes double quotes in attr values so the emitted code stays valid', () => {
    expect(
      renderPlaywright({ strategy: 'attr', attr: { name: 'data-label', value: 'a"b' } }),
    ).toBe('page.locator(\'[data-label="a\\\\"b"]\')');
  });

  it('wraps scope chain outermost first', () => {
    const loc: LocatorDescriptor = {
      strategy: 'role',
      role: 'button',
      name: 'Save',
      scope: [{ strategy: 'role', role: 'dialog', name: 'Confirm' }],
    };
    expect(renderPlaywright(loc)).toBe(
      "page.getByRole('dialog', { name: 'Confirm' }).getByRole('button', { name: 'Save' })",
    );
  });

  it('appends filterText as .filter({ hasText })', () => {
    expect(renderPlaywright({ strategy: 'role', role: 'listitem', filterText: 'Alice' })).toBe(
      "page.getByRole('listitem').filter({ hasText: 'Alice' })",
    );
  });

  it('combines scope + filter + element', () => {
    const loc: LocatorDescriptor = {
      strategy: 'role',
      role: 'button',
      name: 'Edit',
      scope: [{ strategy: 'role', role: 'listitem', filterText: 'Bob' }],
    };
    expect(renderPlaywright(loc)).toBe(
      "page.getByRole('listitem').filter({ hasText: 'Bob' }).getByRole('button', { name: 'Edit' })",
    );
  });

  it('combines two scopes, regex name and filter', () => {
    const loc: LocatorDescriptor = {
      strategy: 'role',
      role: 'cell',
      nameRegex: '\\$\\d+',
      filterText: 'USD',
      scope: [
        { strategy: 'role', role: 'dialog', name: 'Invoice' },
        { strategy: 'role', role: 'row', filterText: 'Total' },
      ],
    };
    expect(renderPlaywright(loc)).toBe(
      "page.getByRole('dialog', { name: 'Invoice' }).getByRole('row').filter({ hasText: 'Total' }).getByRole('cell', { name: /\\$\\d+/ }).filter({ hasText: 'USD' })",
    );
  });
});

describe('renderSelectorList', () => {
  it('returns a single entry for a single-strategy locator', () => {
    expect(renderSelectorList({ strategy: 'role', role: 'button', name: 'Save' })).toEqual([
      "page.getByRole('button', { name: 'Save' })",
    ]);
  });

  it('orders attr before css per the ladder', () => {
    const loc: LocatorDescriptor = {
      strategy: 'attr',
      attr: { name: 'formcontrolname', value: 'email' },
      css: '#email-input',
    };
    expect(renderSelectorList(loc)).toEqual([
      'page.locator(\'[formcontrolname="email"]\')',
      "page.locator('#email-input')",
    ]);
  });

  it('puts role first when a css fallback exists', () => {
    const loc: LocatorDescriptor = {
      strategy: 'role',
      role: 'button',
      name: 'Save',
      css: 'button.save',
    };
    expect(renderSelectorList(loc)).toEqual([
      "page.getByRole('button', { name: 'Save' })",
      "page.locator('button.save')",
    ]);
  });
});
