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
 @Get('activity') async activity(@Query('from') from?:string,@Query('to') to?:string){
  const range=dates(from,to);
  const [payments,movements,sales]=await Promise.all([
   this.db.payment.findMany({where:{createdAt:range},include:{customer:true,sale:true},orderBy:{createdAt:'desc'}}),
   this.db.bottleMovement.findMany({where:{createdAt:range},include:{customer:true,bottleType:true},orderBy:{createdAt:'desc'}}),
   this.db.sale.findMany({where:{createdAt:range,status:'POSTED'},include:{customer:true,payments:true},orderBy:{createdAt:'desc'}}),
  ]);
  type Line={id:string;at:string;date:string;customerName:string;kind:'payment'|'credit'|'bottle';label:string;received:string|null;credited:string|null;bottleDelta:number|null;bottleTypeName:string|null};
  const lines:Line[]=[];
  let totalReceived=zero(),totalCredited=zero(),bottlesOut=0,bottlesIn=0;
  for(const p of payments){
   totalReceived=totalReceived.add(p.amount);
   const d=p.createdAt.toISOString();
   lines.push({id:`pay-${p.id}`,at:d,date:d.slice(0,10),customerName:p.customer?.name||'—',kind:'payment',label:p.saleId?`Payment · ${p.method}`:`Balance payment · ${p.method}`,received:p.amount.toString(),credited:null,bottleDelta:null,bottleTypeName:null});
  }
  for(const s of sales){
   const paid=s.payments.reduce((v,x)=>v.add(x.amount),zero());
   const credit=s.total.sub(paid);
   if(credit.gt(0)){
    totalCredited=totalCredited.add(credit);
    const d=s.createdAt.toISOString();
    lines.push({id:`cred-${s.id}`,at:d,date:d.slice(0,10),customerName:s.customer?.name||s.guestName||'Walk-in',kind:'credit',label:`Sale credit · ${String(s.invoiceNo).slice(0,18)}`,received:null,credited:credit.toString(),bottleDelta:null,bottleTypeName:null});
   }
  }
  for(const b of movements){
   const d=b.createdAt.toISOString();
   const delta=b.delta;
   if(delta>0)bottlesOut+=delta;else if(delta<0)bottlesIn+=-delta;
   const label=b.reason==='RETURN'?'Bottle return':b.reason==='SALE'?'Bottles with customer':'Bottle adjustment';
   lines.push({id:`bot-${b.id}`,at:d,date:d.slice(0,10),customerName:b.customer.name,kind:'bottle',label,bottleDelta:delta,bottleTypeName:b.bottleType.name,received:null,credited:null});
  }
  lines.sort((a,b)=>b.at.localeCompare(a.at));
  return {totals:{received:totalReceived.toString(),credited:totalCredited.toString(),bottlesOut,bottlesIn},lines};
 }
}
