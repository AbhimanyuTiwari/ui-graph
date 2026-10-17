import { Component } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { EditUserDialog } from './edit-user-dialog.component';
import { ConfirmModal } from './confirm-modal.component';

@Component({
  selector: 'app-inbox',
  standalone: true,
  template: `
    <button (click)="edit()">Edit</button>
    <button (click)="confirm()">Remove</button>
    <mat-dialog-content>
      <button>Save</button>
    </mat-dialog-content>
  `,
})
export class InboxComponent {
  constructor(
    private dialog: MatDialog,
    private modal: NgbModal,
  ) {}

  edit(): void {
    this.dialog.open(EditUserDialog);
  }

  confirm(): void {
    this.modal.open(ConfirmModal);
  }
}
