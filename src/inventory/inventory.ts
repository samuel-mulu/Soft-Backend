import { BadRequestException, Body, Controller, Get, Injectable, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Prisma, Role, StockKind, StockReason } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../common/auth';
class AdjustmentDto { @IsEnum(StockKind) kind!:StockKind; @IsOptional() @IsString() productId?:string; @IsOptional() @IsString() bottleTypeId?:string; @IsInt() delta!:number; @IsString() note!:string; }
@Injectable()
export class InventoryService {
 constructor(private db:PrismaService){}
 async change(tx:Prisma.TransactionClient,input:{kind:StockKind;productId?:string;bottleTypeId?:string;delta:number;reason:StockReason;note?:string;purchaseId?:string;saleId?:string;userId:string}){
  const {kind,productId,bottleTypeId,delta,reason,note,purchaseId,saleId,userId}=input;
  if(!Number.isSafeInteger(delta)||delta===0)throw new BadRequestException('Nonzero integer stock change required');
  if((kind===StockKind.FULL_DRINK)!==!!productId || (kind===StockKind.EMPTY_BOTTLE)!==!!bottleTypeId)throw new BadRequestException('Stock target does not match kind');
  // PostgreSQL row locks protect concurrent stock updates. Initial row creation uses an upsert.
  const where=productId?{kind_productId:{kind,productId}}:{kind_bottleTypeId:{kind,bottleTypeId:bottleTypeId!}};
  const row=await tx.stockBalance.upsert({where:where as any,create:{kind,productId,bottleTypeId,quantity:0},update:{}});
  const updated=await tx.stockBalance.updateMany({where:{id:row.id,quantity:{gte:-delta}},data:{quantity:{increment:delta}}});
  if(updated.count!==1){
   let detail='Not enough stock for this product.';
   if(productId){const p=await tx.product.findUnique({where:{id:productId},select:{name:true}});if(p?.name)detail=`Not enough stock for “${p.name}”. Lower the quantity or add stock under Products & stock.`;}
   else if(bottleTypeId){const b=await tx.bottleType.findUnique({where:{id:bottleTypeId},select:{name:true}});if(b?.name)detail=`Not enough empty bottles in warehouse for “${b.name}”.`;}
   throw new BadRequestException(detail);
  }
  await tx.stockMovement.create({data:{kind,productId,bottleTypeId,delta,reason,note,purchaseId,saleId,createdById:userId}});
 }
}
@ApiTags('Inventory') @ApiBearerAuth() @Roles(Role.OWNER, Role.CASHIER) @Controller('inventory')
export class InventoryController {
 constructor(private db:PrismaService,private inventory:InventoryService){}
 @Get('empty-bottle-summary') async emptyBottleSummary(){
  const [bottleTypes,warehouseRows,customerRows]=await Promise.all([
   this.db.bottleType.findMany({where:{active:true},orderBy:{name:'asc'}}),
   this.db.stockBalance.findMany({where:{kind:StockKind.EMPTY_BOTTLE}}),
   this.db.bottleMovement.groupBy({by:['bottleTypeId'],_sum:{delta:true}}),
  ]);
  const warehouse=new Map(warehouseRows.map(r=>[r.bottleTypeId,r.quantity]));
  const withCustomers=new Map(customerRows.map(r=>[r.bottleTypeId,r._sum.delta??0]));
  const rows=bottleTypes.map(b=>({
   bottleTypeId:b.id,
   name:b.name,
   warehouse:warehouse.get(b.id)??0,
   withCustomers:withCustomers.get(b.id)??0,
  }));
  return {
   totals:{
    warehouse:rows.reduce((s,r)=>s+r.warehouse,0),
    withCustomers:rows.reduce((s,r)=>s+r.withCustomers,0),
   },
   rows,
  };
 }
 @Get('balances') balances(){return this.db.stockBalance.findMany({include:{product:true,bottleType:true},orderBy:{updatedAt:'desc'}});}
 @Get('movements') movements(@Query('kind') kind?:StockKind){return this.db.stockMovement.findMany({where:kind?{kind}:{},include:{product:true,bottleType:true},orderBy:{createdAt:'desc'},take:100});}
 @Roles(Role.OWNER) @Post('adjustments') async adjust(@Body() dto:AdjustmentDto,@CurrentUser() user:{id:string}){
  if(!dto.note.trim())throw new BadRequestException('Reason is required');
  return this.db.$transaction(async tx=>{await this.inventory.change(tx,{...dto,userId:user.id,reason:dto.delta>0?StockReason.ADJUSTMENT_IN:StockReason.ADJUSTMENT_OUT});return {success:true};});
 }
}
