import { SalesController } from './sales/sales';
import { PaymentsController, CustomerBottlesController, ExpensesController } from './finance/finance';
import { ReportsController } from './reports/reports';
import { Module } from '@nestjs/common';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PrismaService } from './prisma/prisma.service';
import { AuthGuard } from './common/auth';
import { ApiExceptionFilter } from './common/errors';
import { AuthController, AuthService } from './auth/auth';
import { UsersController } from './users/users';
import { CustomersController } from './customers/customers';
import { CustomerLedgerService } from './customers/customer-ledger';
import { BottlesController } from './bottles/bottles';
import { ProductsController } from './products/products';
import { InventoryController, InventoryService } from './inventory/inventory';
import { HealthController } from './health/health';
import { PortalController } from './portal/portal';
@Module({imports:[ConfigModule.forRoot({isGlobal:true}),JwtModule.registerAsync({useFactory:()=>({secret:process.env.JWT_SECRET||'dev-only-change-me',signOptions:{expiresIn:'8h'}})})],
 controllers:[HealthController,AuthController,PortalController,UsersController,CustomersController,BottlesController,ProductsController,InventoryController,SalesController,PaymentsController,CustomerBottlesController,ExpensesController,ReportsController],
 providers:[PrismaService,AuthService,InventoryService,CustomerLedgerService,{provide:APP_GUARD,useClass:AuthGuard},{provide:APP_FILTER,useClass:ApiExceptionFilter}]})
export class AppModule {}
