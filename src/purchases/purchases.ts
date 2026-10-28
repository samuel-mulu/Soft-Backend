import { BadRequestException, Body, Controller, Get, Injectable, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsInt, IsNumberString, IsOptional, IsString, Min, ValidateNested, ArrayMinSize } from 'class-validator';
import { Type } from 'class-transformer';
import { Prisma, StockKind, StockReason } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser } from '../common/auth';
import { InventoryService } from '../inventory/inventory';
class PurchaseLineDto { @IsString() productId!:string; @IsInt() @Min(1) quantity!:number; @IsNumberString() unitCost!:string; }
class PurchaseDto { @IsString() supplierId!:string; @IsOptional() @IsString() reference?:string; @IsArray() @ArrayMinSize(1) @ValidateNested({each:true}) @Type(()=>PurchaseLineDto) items!:PurchaseLineDto[]; }
@ApiTags('Purchases') @ApiBearerAuth() @Controller('purchases')
export class PurchasesController {
 constructor(private db:PrismaService,private inventory:InventoryService){}
 @Get() list(){return this.db.purchase.findMany({include:{supplier:true,items:{include:{product:true}}},orderBy:{createdAt:'desc'},take:100});}
 @Get(':id') get(@Param('id') id:string){return this.db.purchase.findUniqueOrThrow({where:{id},include:{supplier:true,items:true}});}
 @Post() async receive(@Body() dto:PurchaseDto,@CurrentUser() user:{id:string}){
  if(dto.items.some(x=>!Number.isFinite(Number(x.unitCost))||Number(x.unitCost)<0))throw new BadRequestException('Invalid unit cost');
  const ids=dto.items.map(x=>x.productId);
  if(new Set(ids).size!==ids.length)throw new BadRequestException('Combine duplicate product lines');
  return this.db.$transaction(async tx=>{
   const supplier=await tx.supplier.findUnique({where:{id:dto.supplierId}});
   if(!supplier?.active)throw new BadRequestException('Invalid supplier');
   const products=await tx.product.findMany({where:{id:{in:ids},active:true}});
   if(products.length!==ids.length)throw new BadRequestException('Invalid product');
   const items=dto.items.map(item=>({productId:item.productId,quantity:item.quantity,unitCost:new Prisma.Decimal(item.unitCost),lineTotal:new Prisma.Decimal(item.unitCost).mul(item.quantity)}));
   const total=items.reduce((sum,x)=>sum.add(x.lineTotal),new Prisma.Decimal(0));
   const purchase=await tx.purchase.create({data:{supplierId:dto.supplierId,reference:dto.reference,createdById:user.id,total,items:{create:items}}});
   for(const item of items)await this.inventory.change(tx,{kind:StockKind.FULL_DRINK,productId:item.productId,delta:item.quantity,reason:StockReason.PURCHASE,purchaseId:purchase.id,userId:user.id});
   return tx.purchase.findUniqueOrThrow({where:{id:purchase.id},include:{items:true,supplier:true}});
  },{timeout:10000});
 }
}
