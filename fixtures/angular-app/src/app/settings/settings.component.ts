import { Component } from '@angular/core';

@Component({
  selector: 'app-settings',
  standalone: true,
  template: `
    <h1>Settings</h1>
    <a href="https://docs.example.com">Documentation</a>
    <button (click)="openDocs()">Open docs</button>
  `,
})
export class SettingsComponent {
  openDocs(): void {
    window.open('https://docs.example.com');
  }
}
