import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { CustomerStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
class CustomerDto { @IsString() name!:string; @IsOptional() @IsString() phone?:string; @IsOptional() @IsString() address?:string; @IsOptional() @IsString() notes?:string; }
class UpdateCustomerDto { @IsOptional() @IsString() name?:string; @IsOptional() @IsString() phone?:string; @IsOptional() @IsString() address?:string; @IsOptional() @IsString() notes?:string; @IsOptional() @IsEnum(CustomerStatus) status?:CustomerStatus; }
@ApiTags('Customers') @ApiBearerAuth() @Controller('customers')
export class CustomersController {
 constructor(private db:PrismaService){}
 @Get() async list(@Query('search') search?:string){
  const customers=await this.db.customer.findMany({where:search?{OR:[{name:{contains:search,mode:'insensitive'}},{phone:{contains:search}}]}:{},orderBy:{createdAt:'desc'},take:100});
  const [grouped,salesByCustomer,paymentsByCustomer]=await Promise.all([
   this.db.bottleMovement.groupBy({by:['customerId','bottleTypeId'],_sum:{delta:true}}),
   this.db.sale.groupBy({by:['customerId'],where:{customerId:{not:null}},_sum:{total:true}}),
   this.db.payment.groupBy({by:['customerId'],where:{customerId:{not:null}},_sum:{amount:true}}),
  ]);
  const byCustomer=new Map<string,{bottleTypeId:string;outstanding:number}[]>();
  for(const g of grouped){
   const outstanding=g._sum.delta??0;
   if(!outstanding)continue;
   const list=byCustomer.get(g.customerId)||[];
   list.push({bottleTypeId:g.bottleTypeId,outstanding});
   byCustomer.set(g.customerId,list);
  }
  const salesMap=new Map(salesByCustomer.map(s=>[s.customerId!,s._sum.total??new Prisma.Decimal(0)]));
  const payMap=new Map(paymentsByCustomer.map(p=>[p.customerId!,p._sum.amount??new Prisma.Decimal(0)]));
  return customers.map(c=>{
   const sold=salesMap.get(c.id)??new Prisma.Decimal(0);
   const paid=payMap.get(c.id)??new Prisma.Decimal(0);
   const moneyOutstanding=sold.sub(paid);
   return {...c,bottleBalances:byCustomer.get(c.id)||[],moneyOutstanding};
  });
 }
 @Post() create(@Body() dto:CustomerDto){return this.db.customer.create({data:dto});}
 @Get(':id') get(@Param('id') id:string){return this.db.customer.findUniqueOrThrow({where:{id}});}
 @Patch(':id') update(@Param('id') id:string,@Body() dto:UpdateCustomerDto){return this.db.customer.update({where:{id},data:dto});}
 @Get(':id/history') async history(@Param('id') id:string){const customer=await this.db.customer.findUniqueOrThrow({where:{id}});const [sales,payments,bottles]=await Promise.all([this.db.sale.findMany({where:{customerId:id},include:{items:true},orderBy:{createdAt:'desc'}}),this.db.payment.findMany({where:{customerId:id},orderBy:{createdAt:'desc'}}),this.db.bottleMovement.findMany({where:{customerId:id},include:{bottleType:true},orderBy:{createdAt:'desc'}})]);const debt=sales.reduce((n,s)=>n.add(s.total),new Prisma.Decimal(0)).sub(payments.reduce((n,x)=>n.add(x.amount),new Prisma.Decimal(0)));return {customer,sales,payments,bottles,moneyOutstanding:debt};}
}
