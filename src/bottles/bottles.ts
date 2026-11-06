import { BadRequestException, Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsNumberString, IsOptional, IsString, Min, ValidateIf } from 'class-validator';
import { Role, StockKind, StockReason } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory';
import { CurrentUser, Roles } from '../common/auth';
import { DEFAULT_PACK_SIZE, IsPackSize, assertPackStep } from '../common/pack-quantity';
class BottleDto {
  @IsString() name!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() capacityLabel?: string;
  @IsOptional() @IsNumberString() replacementPrice?: string;
  /** Bottles in one dozen (crate) of this bottle type, e.g. 12 or 24. */
  @IsOptional() @IsPackSize() bottlesPerDozen?: number;
  @IsOptional() @IsInt() @Min(0) initialWarehouseQuantity?: number;
  @ValidateIf((o) => (o.initialWarehouseQuantity ?? 0) > 0) @IsString() note?: string;
}
class UpdateBottleDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() capacityLabel?: string;
  @IsOptional() @IsNumberString() replacementPrice?: string;
  @IsOptional() @IsPackSize() bottlesPerDozen?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}
@ApiTags('Bottle types') @ApiBearerAuth() @Roles(Role.OWNER, Role.CASHIER) @Controller('bottle-types')
export class BottlesController {
 constructor(private db:PrismaService,private inventory:InventoryService){}
 @Get() list(){return this.db.bottleType.findMany({orderBy:{name:'asc'}});}
 @Roles(Role.OWNER) @Post() create(@Body() dto:BottleDto,@CurrentUser() user:{id:string}){
  const name=dto.name?.trim();
  if(!name)throw new BadRequestException('Bottle name is required');
  const qty=dto.initialWarehouseQuantity??0;
  const size=dto.bottlesPerDozen??DEFAULT_PACK_SIZE;
  assertPackStep(qty,size,'initialWarehouseQuantity');
  if(qty>0&&!dto.note?.trim())throw new BadRequestException('Reason is required when setting warehouse stock');
  return this.db.$transaction(async tx=>{
   const bottle=await tx.bottleType.create({data:{
    name,
    description:dto.description?.trim()||undefined,
    capacityLabel:dto.capacityLabel?.trim()||undefined,
    replacementPrice:dto.replacementPrice,
    bottlesPerDozen:size,
   }});
   if(qty>0)await this.inventory.change(tx,{kind:StockKind.EMPTY_BOTTLE,bottleTypeId:bottle.id,delta:qty,reason:StockReason.OPENING,note:dto.note!.trim(),userId:user.id});
   return bottle;
  });
 }
 @Roles(Role.OWNER) @Patch(':id') update(@Param('id') id:string,@Body() dto:UpdateBottleDto){
  return this.db.$transaction(async tx=>{
   const bottle=await tx.bottleType.update({where:{id},data:dto});
   // Returnable products always use their bottle type's dozen size.
   if(dto.bottlesPerDozen!==undefined)await tx.product.updateMany({where:{bottleTypeId:id},data:{unitsPerCase:dto.bottlesPerDozen}});
   return bottle;
  });
 }
}
