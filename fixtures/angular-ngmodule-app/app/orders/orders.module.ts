import { NgModule } from '@angular/core';
import { OrdersRoutingModule } from './orders-routing.module';
import { OrderListComponent } from './order-list.component';

@NgModule({ imports: [OrdersRoutingModule], declarations: [OrderListComponent] })
export class OrdersModule {}
