import { NgModule } from '@angular/core';
import { RouterModule } from '@angular/router';
import { AuthGuard } from './shell/auth.guard';

@NgModule({
  imports: [
    RouterModule.forRoot([
      { path: 'orders', canActivate: [AuthGuard], loadChildren: () => import('./orders/orders.module').then((m) => m.OrdersModule) },
      { path: 'reports', loadChildren: () => import('./reports/reports.module').then((m) => m.ReportsModule) },
      { path: 'missing', loadChildren: () => import('@alias/not/here').then((m) => m.GoneModule) },
      { path: '', pathMatch: 'full', redirectTo: 'orders' },
    ]),
  ],
  exports: [RouterModule],
})
export class AppRoutingModule {}
