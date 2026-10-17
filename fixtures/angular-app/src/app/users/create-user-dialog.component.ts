import { Component } from '@angular/core';

@Component({
  selector: 'app-create-user-dialog',
  standalone: true,
  template: `
    <h2>Create user</h2>
    <button (click)="create()">Create</button>
  `,
})
export class CreateUserDialog {
  create(): void {
    // Fixture stub: the dialog body is not part of the extraction contract.
  }
}
