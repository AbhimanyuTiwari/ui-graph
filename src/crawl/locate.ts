/**
 * Shared LocatorDescriptor -> Playwright Locator builder, used by both the
 * crawler (uniqueness probing) and the probe runner (step execution).
 * Descriptors are structured data — never code strings, never positional.
 */
import type { Locator, Page } from 'playwright';
import type { LocatorDescriptor } from '../types';

type AriaRole = Parameters<Locator['getByRole']>[0];

/** Page and Locator share the getByX / locator surface we need. */
type Root = Pick<Page, 'getByRole' | 'getByLabel' | 'getByPlaceholder' | 'getByText' | 'locator'>;

function escapeAttrValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildOne(root: Root, desc: LocatorDescriptor): Locator {
  let loc: Locator;
  switch (desc.strategy) {
    case 'role': {
      if (desc.role === undefined) throw new Error("locator strategy 'role' needs a role");
      const name =
        desc.name !== undefined
          ? desc.name
          : desc.nameRegex !== undefined
            ? new RegExp(desc.nameRegex)
            : undefined;
      loc = root.getByRole(
        desc.role as AriaRole,
        name === undefined ? undefined : { name, exact: typeof name === 'string' },
      );
      break;
    }
    case 'label': {
      if (desc.name === undefined) throw new Error("locator strategy 'label' needs a name");
      loc = root.getByLabel(desc.name, { exact: true });
      break;
    }
    case 'placeholder': {
      if (desc.name === undefined) throw new Error("locator strategy 'placeholder' needs a name");
      loc = root.getByPlaceholder(desc.name, { exact: true });
      break;
    }
    case 'text': {
      const text =
        desc.name !== undefined
          ? desc.name
          : desc.nameRegex !== undefined
            ? new RegExp(desc.nameRegex)
            : undefined;
      if (text === undefined) throw new Error("locator strategy 'text' needs a name or nameRegex");
      loc = root.getByText(text);
      break;
    }
    case 'attr': {
      if (desc.attr === undefined) throw new Error("locator strategy 'attr' needs attr");
      loc = root.locator(`[${desc.attr.name}="${escapeAttrValue(desc.attr.value)}"]`);
      break;
    }
    case 'css': {
      if (desc.css === undefined) throw new Error("locator strategy 'css' needs css");
      loc = root.locator(desc.css);
      break;
    }
  }
  if (desc.filterText !== undefined) {
    loc = loc.filter({ hasText: desc.filterText });
  }
  return loc;
}

/**
 * Resolve a descriptor to a live Locator. The scope chain (outermost first)
 * narrows the search root before the final strategy is applied.
 */
export function buildLocator(root: Page | Locator, desc: LocatorDescriptor): Locator {
  let base: Root = root;
  for (const scope of desc.scope ?? []) {
    base = buildOne(base, scope);
  }
  return buildOne(base, desc);
}
