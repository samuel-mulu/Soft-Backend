import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Roles } from '../common/auth';
const zero=()=>new Prisma.Decimal(0);
function dates(from?:string,to?:string){const start=from?new Date(`${from}T00:00:00.000Z`):new Date(new Date().toISOString().slice(0,10)+'T00:00:00.000Z');const end=to?new Date(`${to}T23:59:59.999Z`):new Date();if(isNaN(+start)||isNaN(+end)||start>end)throw new BadRequestException('Invalid date range; use YYYY-MM-DD');return {gte:start,lte:end};}
@ApiTags('Reports') @ApiBearerAuth() @Roles(Role.OWNER) @Controller('reports')
export class ReportsController {
 constructor(private db:PrismaService){}
 @Get('summary') async summary(@Query('from') from?:string,@Query('to') to?:string){
  const range=dates(from,to);
  // Neon pooler: avoid 9 parallel queries (P2024 connection pool timeout).
  const [sales,receipts,expenses,items]=await Promise.all([
   this.db.sale.aggregate({where:{createdAt:range,status:'POSTED'},_sum:{total:true,discount:true},_count:true}),
   this.db.payment.aggregate({where:{createdAt:range},_sum:{amount:true}}),
   this.db.expense.aggregate({where:{createdAt:range},_sum:{amount:true}}),
   this.db.saleItem.findMany({where:{sale:{createdAt:range,status:'POSTED'}},select:{quantity:true,unitCost:true}}),
  ]);
  const [bottles,allSales,allPayments]=await Promise.all([
   this.db.bottleMovement.groupBy({by:['bottleTypeId'],_sum:{delta:true}}),
   this.db.sale.aggregate({where:{status:'POSTED'},_sum:{total:true}}),
   this.db.payment.aggregate({_sum:{amount:true}}),
  ]);
  const revenue=sales._sum.total||zero(),cost=items.reduce((v,x)=>v.add(x.unitCost.mul(x.quantity)),zero());
  const expenseTotal=expenses._sum.amount||zero(),cashIn=receipts._sum.amount||zero(),cashOut=expenseTotal;
  return {period:{from:range.gte,to:range.lte},salesCount:sales._count,salesRevenue:revenue,discounts:sales._sum.discount||zero(),cashReceived:cashIn,expenses:expenseTotal,cashFlow:cashIn.sub(cashOut),costOfGoodsSold:cost,grossProfit:revenue.sub(cost),estimatedNetProfit:revenue.sub(cost).sub(expenseTotal),customerReceivables:(allSales._sum.total||zero()).sub(allPayments._sum.amount||zero()),outstandingBottles:bottles.map(x=>({bottleTypeId:x.bottleTypeId,quantity:x._sum.delta||0}))};
 }
 @Get('customers') async customers(){const rows=await this.db.customer.findMany({select:{id:true,name:true,phone:true,status:true,sales:{where:{status:'POSTED'},select:{total:true}},payments:{select:{amount:true}},bottleMovements:{select:{bottleTypeId:true,delta:true}}}});return rows.map(x=>{const debt=x.sales.reduce((v,s)=>v.add(s.total),zero()).sub(x.payments.reduce((v,p)=>v.add(p.amount),zero()));const bottles:Record<string,number>={};for(const b of x.bottleMovements)bottles[b.bottleTypeId]=(bottles[b.bottleTypeId]||0)+b.delta;return {id:x.id,name:x.name,phone:x.phone,status:x.status,debt,bottles};});}
 @Get('stock') stock(){return this.db.stockBalance.findMany({include:{product:true,bottleType:true}});}
 @Get('daily') async daily(@Query('from') from?:string,@Query('to') to?:string){const range=dates(from,to);const sales=await this.db.sale.findMany({where:{createdAt:range,status:'POSTED'},select:{createdAt:true,total:true}});const payments=await this.db.payment.findMany({where:{createdAt:range},select:{createdAt:true,amount:true}});const byDay:Record<string,{date:string;sales:string;received:string;count:number}>={};for(const s of sales){const d=s.createdAt.toISOString().slice(0,10);byDay[d]??={date:d,sales:'0',received:'0',count:0};byDay[d].sales=new Prisma.Decimal(byDay[d].sales).add(s.total).toString();byDay[d].count++;}for(const p of payments){const d=p.createdAt.toISOString().slice(0,10);byDay[d]??={date:d,sales:'0',received:'0',count:0};byDay[d].received=new Prisma.Decimal(byDay[d].received).add(p.amount).toString();}return Object.values(byDay).sort((a,b)=>a.date.localeCompare(b.date));}
}
