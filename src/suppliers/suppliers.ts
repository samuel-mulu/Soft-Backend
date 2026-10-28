import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Roles } from '../common/auth';
class SupplierDto { @IsString() name!:string; @IsOptional() @IsString() phone?:string; @IsOptional() @IsString() address?:string; }
class UpdateSupplierDto { @IsOptional() @IsString() name?:string; @IsOptional() @IsString() phone?:string; @IsOptional() @IsString() address?:string; @IsOptional() @IsBoolean() active?:boolean; }
@ApiTags('Suppliers') @ApiBearerAuth() @Controller('suppliers')
export class SuppliersController {
 constructor(private db:PrismaService){}
 @Get() list(){return this.db.supplier.findMany({orderBy:{name:'asc'}});}
 @Roles(Role.OWNER) @Post() create(@Body() dto:SupplierDto){return this.db.supplier.create({data:dto});}
 @Roles(Role.OWNER) @Patch(':id') update(@Param('id') id:string,@Body() dto:UpdateSupplierDto){return this.db.supplier.update({where:{id},data:dto});}
}
