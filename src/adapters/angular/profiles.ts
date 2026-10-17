/**
 * Component-library profiles. They tell the Angular adapter which constructor
 * types open an overlay, and which host tags should scope locators to a dialog.
 */
import type { LocatorDescriptor } from '../../types.js';

export interface LibraryProfile {
  name: 'ng-bootstrap' | 'material';
  dialogTypes: string[];
  dialogProps: string[];
  /** Template tag -> locator scope pushed while walking its children. */
  hosts: Record<string, LocatorDescriptor>;
}

const dialogScope: LocatorDescriptor = { strategy: 'role', role: 'dialog' };

export const NG_BOOTSTRAP: LibraryProfile = {
  name: 'ng-bootstrap',
  dialogTypes: ['NgbModal'],
  dialogProps: ['modal'],
  hosts: {
    'ngb-modal-window': dialogScope,
  },
};

export const MATERIAL: LibraryProfile = {
  name: 'material',
  dialogTypes: ['MatDialog'],
  dialogProps: ['dialog'],
  hosts: {
    'mat-dialog-content': dialogScope,
    'mat-dialog-actions': dialogScope,
  },
};

const PROFILES = [NG_BOOTSTRAP, MATERIAL];

export function profileForDialog(typeName: string | undefined, prop: string | undefined): LibraryProfile | undefined {
  return PROFILES.find(
    (profile) =>
      (typeName !== undefined && profile.dialogTypes.includes(typeName)) ||
      (prop !== undefined && profile.dialogProps.includes(prop) && typeName !== 'Dialog'),
  );
}

export function hostScope(tag: string): LocatorDescriptor | undefined {
  for (const profile of PROFILES) {
    const scope = profile.hosts[tag];
    if (scope) return scope;
  }
  return undefined;
}
