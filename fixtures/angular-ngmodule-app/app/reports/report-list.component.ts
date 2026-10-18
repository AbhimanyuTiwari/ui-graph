import { Component } from '@angular/core';

@Component({ selector: 'app-report-list', template: '<button (click)="run()">Run report</button>' })
export class ReportListComponent {
  run(): void {}
}
