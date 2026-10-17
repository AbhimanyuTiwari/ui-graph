import { Component } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

@Component({
  selector: 'app-user-detail',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink],
  template: `
    <div *ngIf="error">Something went wrong</div>
    <a routerLink="/users">Back to users</a>
    <form [formGroup]="form" (ngSubmit)="save()">
      <label for="name">Name</label>
      <input id="name" formControlName="name" />
      <label for="detail-email">Email</label>
      <input id="detail-email" formControlName="email" />
      <button type="submit">Save</button>
    </form>
    <button (click)="onDelete()">Delete</button>
    <button aria-label="Close" (click)="close()">x</button>
  `,
})
export class UserDetailComponent {
  id = '';
  error = false;

  form = this.fb.group({
    name: ['', [Validators.required]],
    email: ['', [Validators.required, Validators.email]],
  });

  constructor(
    private fb: FormBuilder,
    private http: HttpClient,
    private router: Router,
  ) {}

  save(): void {
    this.http.put(`/api/users/${this.id}`, this.form.value).subscribe();
  }

  onDelete(): void {
    if (confirm('Delete this user?')) {
      this.http.delete(`/api/users/${this.id}`).subscribe(() => {
        this.router.navigate(['/users']);
      });
    }
  }

  close(): void {
    this.router.navigate(['/users']);
  }
}
