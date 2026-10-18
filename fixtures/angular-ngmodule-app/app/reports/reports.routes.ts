import { Route } from '@angular/router';
import { ReportListComponent } from './report-list.component';

// A layout route whose empty-path child renders the screen: both share one URL.
export const reportRoutes: Route[] = [
  { path: 'sales', children: [{ path: '', component: ReportListComponent }] },
];
