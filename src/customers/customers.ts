import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { CustomerStatus, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerLedgerService } from './customer-ledger';
import { Roles } from '../common/auth';
import { normalizeEtPhone } from '../common/phone';
class CustomerDto { @IsString() name!:string; @IsOptional() @IsString() phone?:string; @IsOptional() @IsString() address?:string; @IsOptional() @IsString() notes?:string; }
class UpdateCustomerDto { @IsOptional() @IsString() name?:string; @IsOptional() @IsString() phone?:string; @IsOptional() @IsString() address?:string; @IsOptional() @IsString() notes?:string; @IsOptional() @IsEnum(CustomerStatus) status?:CustomerStatus; }
@ApiTags('Customers') @ApiBearerAuth() @Roles(Role.OWNER, Role.CASHIER) @Controller('customers')
export class CustomersController {
 constructor(private db:PrismaService,private ledger:CustomerLedgerService){}
 @Get() async list(@Query('search') search?:string){
  const customers=await this.db.customer.findMany({where:search?{OR:[{name:{contains:search,mode:'insensitive'}},{phone:{contains:search}}]}:{},orderBy:{createdAt:'desc'},take:100});
  const [grouped,salesByCustomer,paymentsByCustomer]=await Promise.all([
   this.db.bottleMovement.groupBy({by:['customerId','bottleTypeId'],_sum:{delta:true}}),
   this.db.sale.groupBy({by:['customerId'],where:{customerId:{not:null}},_sum:{total:true}}),
   this.db.payment.groupBy({by:['customerId'],where:{customerId:{not:null}},_sum:{amount:true}}),
  ]);
  const byCustomer=new Map<string,{bottleTypeId:string;outstanding:number}[]>();
  for(const g of grouped){
   for(const row of this.ledger.bottleBalanceRowsFromGrouped([{bottleTypeId:g.bottleTypeId,_sum:{delta:g._sum.delta}}])){
    const list=byCustomer.get(g.customerId)||[];
    list.push(row);
    byCustomer.set(g.customerId,list);
   }
  }
  const salesMap=new Map(salesByCustomer.map(s=>[s.customerId!,s._sum.total??new Prisma.Decimal(0)]));
  const payMap=new Map(paymentsByCustomer.map(p=>[p.customerId!,p._sum.amount??new Prisma.Decimal(0)]));
  return customers.map(c=>{
   const moneyOutstanding=this.ledger.moneyOutstandingFromTotals(salesMap.get(c.id)??new Prisma.Decimal(0),payMap.get(c.id)??new Prisma.Decimal(0));
   return {...c,bottleBalances:byCustomer.get(c.id)||[],moneyOutstanding};
  });
 }
 @Post() create(@Body() dto:CustomerDto){
  const phone=dto.phone?normalizeEtPhone(dto.phone):null;
  if(dto.phone?.trim()&&!phone)throw new BadRequestException('Phone must start with 09 or 10 and be 10 digits');
  return this.db.customer.create({data:{...dto,phone:phone??undefined}});
 }
 @Get(':id') get(@Param('id') id:string){return this.db.customer.findUniqueOrThrow({where:{id}});}
 @Patch(':id') update(@Param('id') id:string,@Body() dto:UpdateCustomerDto){
  const data={...dto} as UpdateCustomerDto;
  if(dto.phone!==undefined){
   if(!dto.phone?.trim())data.phone=undefined;
   else{const phone=normalizeEtPhone(dto.phone);if(!phone)throw new BadRequestException('Phone must start with 09 or 10 and be 10 digits');data.phone=phone;}
  }
  return this.db.customer.update({where:{id},data});
 }
 @Get(':id/history') async history(@Param('id') id:string){
  const customer=await this.db.customer.findUniqueOrThrow({where:{id}});
  const [sales,payments,bottles,moneyOutstanding,bottleBalances]=await Promise.all([
   this.db.sale.findMany({where:{customerId:id},include:{items:true,payments:true},orderBy:{createdAt:'desc'}}),
   this.db.payment.findMany({where:{customerId:id},orderBy:{createdAt:'desc'}}),
   this.db.bottleMovement.findMany({where:{customerId:id},include:{bottleType:true},orderBy:{createdAt:'desc'}}),
   this.ledger.moneyOutstanding(id),
   this.ledger.bottleBalances(id),
  ]);
  return {customer,sales,payments,bottles,moneyOutstanding,bottleBalances};
 }
}
