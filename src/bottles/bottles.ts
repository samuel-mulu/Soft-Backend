import { BadRequestException, Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Min, ValidateIf } from 'class-validator';
import { Role, StockKind, StockReason } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory';
import { CurrentUser, Roles } from '../common/auth';
class BottleDto { @IsString() name!:string; @IsOptional() @IsString() description?:string; @IsOptional() @IsInt() @Min(0) initialWarehouseQuantity?:number; @ValidateIf((o)=>(o.initialWarehouseQuantity??0)>0) @IsString() note?:string; }
class UpdateBottleDto { @IsOptional() @IsString() name?:string; @IsOptional() @IsString() description?:string; @IsOptional() @IsBoolean() active?:boolean; }
@ApiTags('Bottle types') @ApiBearerAuth() @Roles(Role.OWNER, Role.CASHIER) @Controller('bottle-types')
export class BottlesController {
 constructor(private db:PrismaService,private inventory:InventoryService){}
 @Get() list(){return this.db.bottleType.findMany({orderBy:{name:'asc'}});}
 @Roles(Role.OWNER) @Post() create(@Body() dto:BottleDto,@CurrentUser() user:{id:string}){
  const name=dto.name?.trim();
  if(!name)throw new BadRequestException('Bottle name is required');
  const qty=dto.initialWarehouseQuantity??0;
  if(qty>0&&!dto.note?.trim())throw new BadRequestException('Reason is required when setting warehouse stock');
  return this.db.$transaction(async tx=>{
   const bottle=await tx.bottleType.create({data:{name,description:dto.description?.trim()||undefined}});
   if(qty>0)await this.inventory.change(tx,{kind:StockKind.EMPTY_BOTTLE,bottleTypeId:bottle.id,delta:qty,reason:StockReason.OPENING,note:dto.note!.trim(),userId:user.id});
   return bottle;
  });
 }
 @Roles(Role.OWNER) @Patch(':id') update(@Param('id') id:string,@Body() dto:UpdateBottleDto){return this.db.bottleType.update({where:{id},data:dto});}
}
