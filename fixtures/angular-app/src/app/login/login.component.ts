import { Component } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../auth/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [ReactiveFormsModule],
  template: `
    <h1>Sign in to your account</h1>
    <form [formGroup]="form" (ngSubmit)="onSubmit()">
      <label for="email">Email</label>
      <input id="email" type="text" formControlName="email" />
      <label for="password">Password</label>
      <input id="password" type="password" formControlName="password" />
      <button type="submit">Sign in</button>
    </form>
  `,
})
export class LoginComponent {
  form = this.fb.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required]],
  });

  constructor(
    private fb: FormBuilder,
    private auth: AuthService,
    private router: Router,
  ) {}

  onSubmit(): void {
    this.auth.login({
      email: this.form.value.email ?? '',
      password: this.form.value.password ?? '',
    }).subscribe(() => {
      this.router.navigate(['/users']);
    });
  }
}
