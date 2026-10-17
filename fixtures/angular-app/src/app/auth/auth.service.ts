import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface Credentials {
  email: string;
  password: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  constructor(private http: HttpClient) {}

  login(credentials: Credentials): Observable<unknown> {
    return this.http.post('/api/login', credentials);
  }

  isLoggedIn(): boolean {
    return true;
  }
}
