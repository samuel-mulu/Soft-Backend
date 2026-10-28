import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
 catch(exception:unknown,host:ArgumentsHost){
  const response=host.switchToHttp().getResponse();
  let status=HttpStatus.INTERNAL_SERVER_ERROR; let message:unknown='Internal server error';
  if(exception instanceof HttpException){status=exception.getStatus();message=exception.getResponse();}
  else if(exception instanceof Prisma.PrismaClientKnownRequestError){
   if(exception.code==='P2002'){status=409;message='Duplicate unique value';}
   else if(exception.code==='P2025'){status=404;message='Record not found';}
   else if(exception.code==='P1001'){status=503;message='Could not reach the database. Try again in a moment.';}
   else if(exception.code==='P2024'||exception.code==='P2028'){status=503;message='Could not reach the database. Try again in a moment.';}
  }
  const text=typeof message==='string'?message:Array.isArray((message as {message?:unknown})?.message)?((message as {message:string[]}).message).flatMap(x=>typeof x==='string'?x:Object.values((x as {constraints?:Record<string,string>}).constraints||{})).join('; '):typeof (message as {message?:unknown})?.message==='string'?(message as {message:string}).message:'Request failed';
  if(status>=500)console.error(exception);
  else if(exception instanceof Prisma.PrismaClientKnownRequestError&&['P1001','P1002','P2024','P2028'].includes(exception.code))console.warn(`Database unavailable (${exception.code})`);
  response.status(status).json({statusCode:status,message:text,error:text,timestamp:new Date().toISOString()});
 }
}
