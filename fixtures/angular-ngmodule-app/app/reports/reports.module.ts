import { NgModule } from '@angular/core';
import { RouterModule } from '@angular/router';
import { reportRoutes } from './reports.routes';

@NgModule({ imports: [RouterModule.forChild(reportRoutes)] })
export class ReportsModule {}
