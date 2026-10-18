import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { OrderListComponent } from './order-list.component';

export const routes: Routes = [
  { path: '', component: OrderListComponent },
  { path: ':orderId', component: OrderListComponent },
];

@NgModule({ imports: [RouterModule.forChild(routes)], exports: [RouterModule] })
export class OrdersRoutingModule {}
