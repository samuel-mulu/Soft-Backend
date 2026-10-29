import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsInt, IsNumberString, IsOptional, IsString } from 'class-validator';
import { BottleReason, PaymentMethod, Prisma, Role, StockKind, StockReason } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory';
import { CurrentUser, Roles } from '../common/auth';
const amount=(v:string)=>{const n=new Prisma.Decimal(v);if(!n.isFinite()||n.lte(0))throw new BadRequestException('Amount must be positive');return n;};
class PaymentDto { @IsString() customerId!:string; @IsOptional() @IsString() saleId?:string; @IsNumberString() amount!:string; @IsOptional() @IsEnum(PaymentMethod) method?:PaymentMethod; @IsOptional() @IsString() note?:string; }
class ReturnDto { @IsString() customerId!:string; @IsString() bottleTypeId!:string; @IsInt() quantity!:number; @IsOptional() @IsString() note?:string; }
class CorrectionDto extends ReturnDto { @IsString() reason!:string; }
class ExpenseDto { @IsString() category!:string; @IsString() description!:string; @IsNumberString() amount!:string; @IsOptional() @IsEnum(PaymentMethod) method?:PaymentMethod; }
class SupplierPayDto { @IsString() purchaseId!:string; @IsNumberString() amount!:string; @IsOptional() @IsEnum(PaymentMethod) method?:PaymentMethod; @IsOptional() @IsString() note?:string; }
@ApiTags('Customer payments') @ApiBearerAuth() @Roles(Role.OWNER, Role.CASHIER) @Controller('payments')
export class PaymentsController {
 constructor(private db:PrismaService){}
 @Get() list(@Query('customerId') customerId?:string){return this.db.payment.findMany({where:customerId?{customerId}:{},orderBy:{createdAt:'desc'},take:100});}
 @Post() async pay(@Body() dto:PaymentDto,@CurrentUser() user:{id:string}){
  const value=amount(dto.amount);
  return this.db.$transaction(async tx=>{
   const customer=await tx.customer.findUnique({where:{id:dto.customerId}});if(!customer)throw new BadRequestException('Customer not found');
   const sales=await tx.sale.aggregate({where:{customerId:dto.customerId,status:'POSTED'},_sum:{total:true}});
   const payments=await tx.payment.aggregate({where:{customerId:dto.customerId},_sum:{amount:true}});
   const outstanding=(sales._sum.total||new Prisma.Decimal(0)).sub(payments._sum.amount||new Prisma.Decimal(0));
   if(value.gt(outstanding))throw new BadRequestException('Payment exceeds customer outstanding debt');
   if(dto.saleId){const sale=await tx.sale.findUnique({where:{id:dto.saleId}});if(!sale||sale.customerId!==dto.customerId)throw new BadRequestException('Invoice does not belong to customer');const paid=await tx.payment.aggregate({where:{saleId:sale.id},_sum:{amount:true}});if(value.gt(sale.total.sub(paid._sum.amount||new Prisma.Decimal(0))))throw new BadRequestException('Payment exceeds invoice balance');}
   return tx.payment.create({data:{customerId:dto.customerId,saleId:dto.saleId,amount:value,method:dto.method||PaymentMethod.CASH,note:dto.note,createdById:user.id}});
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
 }
}
@ApiTags('Bottle ledger') @ApiBearerAuth() @Roles(Role.OWNER, Role.CASHIER) @Controller('customer-bottles')
export class CustomerBottlesController {
 constructor(private db:PrismaService,private inventory:InventoryService){}
 @Get(':customerId') async ledger(@Param('customerId') customerId:string){const movements=await this.db.bottleMovement.findMany({where:{customerId},include:{bottleType:true},orderBy:{createdAt:'desc'},take:500});const totals=await this.db.bottleMovement.groupBy({by:['bottleTypeId'],where:{customerId},_sum:{delta:true}});return {totals:totals.map(x=>({bottleTypeId:x.bottleTypeId,outstanding:x._sum.delta||0})),movements};}
 @Post('returns') async returnBottles(@Body() dto:ReturnDto,@CurrentUser() user:{id:string}){if(!Number.isSafeInteger(dto.quantity)||dto.quantity<=0)throw new BadRequestException('Quantity must be positive');return this.db.$transaction(async tx=>{const customer=await tx.customer.findUnique({where:{id:dto.customerId}});const bt=await tx.bottleType.findUnique({where:{id:dto.bottleTypeId}});if(!customer||!bt)throw new BadRequestException('Invalid customer or bottle type');const current=await tx.bottleMovement.aggregate({where:{customerId:dto.customerId,bottleTypeId:dto.bottleTypeId},_sum:{delta:true}});if((current._sum.delta||0)<dto.quantity)throw new BadRequestException('Return exceeds outstanding bottles');const entry=await tx.bottleMovement.create({data:{customerId:dto.customerId,bottleTypeId:dto.bottleTypeId,delta:-dto.quantity,reason:BottleReason.RETURN,note:dto.note,createdById:user.id}});await this.inventory.change(tx,{kind:StockKind.EMPTY_BOTTLE,bottleTypeId:dto.bottleTypeId,delta:dto.quantity,reason:StockReason.BOTTLE_RETURN,userId:user.id});return entry;},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});}
 @Roles(Role.OWNER) @Post('corrections') async correct(@Body() dto:CorrectionDto,@CurrentUser() user:{id:string}){if(!dto.quantity||!Number.isSafeInteger(dto.quantity)||!dto.reason?.trim())throw new BadRequestException('Nonzero quantity and reason required');return this.db.$transaction(async tx=>{const old=await tx.bottleMovement.aggregate({where:{customerId:dto.customerId,bottleTypeId:dto.bottleTypeId},_sum:{delta:true}});if((old._sum.delta||0)+dto.quantity<0)throw new BadRequestException('Negative bottle debt not allowed');const entry=await tx.bottleMovement.create({data:{customerId:dto.customerId,bottleTypeId:dto.bottleTypeId,delta:dto.quantity,reason:BottleReason.ADJUSTMENT,note:dto.reason,createdById:user.id}});return entry;},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});}
}
@ApiTags('Expenses') @ApiBearerAuth() @Roles(Role.OWNER, Role.CASHIER) @Controller('expenses')
export class ExpensesController {
 constructor(private db:PrismaService){}
 @Get() list(){return this.db.expense.findMany({orderBy:{createdAt:'desc'},take:100});}
 @Post() create(@Body() dto:ExpenseDto,@CurrentUser() user:{id:string}){return this.db.expense.create({data:{...dto,amount:amount(dto.amount),method:dto.method||PaymentMethod.CASH,createdById:user.id}});}
}
@ApiTags('Supplier payments') @ApiBearerAuth() @Controller('purchase-payments')
export class PurchasePaymentsController {
 constructor(private db:PrismaService){}
 @Get() list(){return this.db.purchasePayment.findMany({include:{supplier:true,purchase:true},orderBy:{createdAt:'desc'},take:100});}
 @Post() pay(@Body() dto:SupplierPayDto,@CurrentUser() user:{id:string}){return this.db.$transaction(async tx=>{const purchase=await tx.purchase.findUnique({where:{id:dto.purchaseId}});if(!purchase)throw new BadRequestException('Purchase not found');const previous=await tx.purchasePayment.aggregate({where:{purchaseId:purchase.id},_sum:{amount:true}});const value=amount(dto.amount);if(value.gt(purchase.total.sub(previous._sum.amount||new Prisma.Decimal(0))))throw new BadRequestException('Payment exceeds purchase balance');return tx.purchasePayment.create({data:{purchaseId:purchase.id,supplierId:purchase.supplierId,amount:value,method:dto.method||PaymentMethod.CASH,note:dto.note,createdById:user.id}});},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});}
}
