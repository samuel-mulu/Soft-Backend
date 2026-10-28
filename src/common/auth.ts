import { SetMetadata, createParamDecorator, ExecutionContext, Injectable, CanActivate, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '@prisma/client';
import { rethrowDatabaseError } from './db-errors';
export const Public = () => SetMetadata('public',true);
export const Roles = (...roles:Role[]) => SetMetadata('roles',roles);
export const CurrentUser = createParamDecorator((_data:unknown,ctx:ExecutionContext)=>ctx.switchToHttp().getRequest().user as {id:string;role:Role});
@Injectable()
export class AuthGuard implements CanActivate {
 constructor(private reflector:Reflector,private jwt:JwtService,private prisma:PrismaService){}
 async canActivate(context:ExecutionContext){
  if(this.reflector.getAllAndOverride<boolean>('public',[context.getHandler(),context.getClass()]))return true;
  const req=context.switchToHttp().getRequest(); const token=(req.headers.authorization||'').replace(/^Bearer /i,'');
  if(!token)throw new UnauthorizedException();
  let payload:{sub:string}; try{payload=await this.jwt.verifyAsync(token);}catch{throw new UnauthorizedException('Invalid token');}
  let user;try{user=await this.prisma.user.findUnique({where:{id:payload.sub},select:{id:true,role:true,active:true}});}catch(err){rethrowDatabaseError(err);}
  if(!user?.active)throw new UnauthorizedException(user?'Account inactive':'Session invalid — sign in again'); req.user=user;
  const roles=this.reflector.getAllAndOverride<Role[]>('roles',[context.getHandler(),context.getClass()]);
  if(roles?.length&&!roles.includes(user.role))throw new ForbiddenException();
  return true;
 }
}
