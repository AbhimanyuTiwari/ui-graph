import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { Dialog } from '@angular/cdk/dialog';
import { User, UserApiService } from './user-api.service';
import { CreateUserDialog } from './create-user-dialog.component';

@Component({
  selector: 'app-user-list',
  standalone: true,
  templateUrl: './user-list.component.html',
})
export class UserListComponent implements OnInit {
  users: User[] = [];

  constructor(
    private api: UserApiService,
    private router: Router,
    private dialog: Dialog,
  ) {}

  ngOnInit(): void {
    this.api.list().subscribe((users) => {
      this.users = users;
    });
  }

  openEdit(user: User): void {
    this.router.navigate(['/users', user.id]);
  }

  openCreate(): void {
    this.dialog.open(CreateUserDialog);
  }

  refresh(): void {
    this.api.list().subscribe((users) => {
      this.users = users;
    });
  }
}
