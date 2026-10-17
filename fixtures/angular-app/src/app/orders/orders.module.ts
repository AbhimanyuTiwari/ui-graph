import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { OrdersListComponent } from './orders-list.component';

const ordersRoutes: Routes = [{ path: '', component: OrdersListComponent }];

@NgModule({
  imports: [RouterModule.forChild(ordersRoutes)],
  declarations: [OrdersListComponent],
})
export class OrdersModule {}
