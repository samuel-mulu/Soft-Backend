import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { Role } from '@prisma/client';
import { hash } from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../common/auth';
const STAFF_ROLES = [Role.OWNER, Role.CASHIER] as const;
class CreateUserDto { @IsString() username!:string; @IsString() @MinLength(4) password!:string; @IsIn(STAFF_ROLES) role!:Role; }
class UpdateUserDto { @IsOptional() @IsBoolean() active?:boolean; @IsOptional() @IsString() @MinLength(4) password?:string; }
@ApiTags('Users') @ApiBearerAuth() @Roles(Role.OWNER) @Controller('users')
export class UsersController {
 constructor(private db:PrismaService){}
 @Get() list(){return this.db.user.findMany({select:{id:true,username:true,role:true,active:true,createdAt:true}});}
 @Post() async create(@Body() dto:CreateUserDto){return this.db.user.create({data:{username:dto.username,passwordHash:await hash(dto.password,12),role:dto.role},select:{id:true,username:true,role:true,active:true}});}
 @Patch(':id') async update(@Param('id') id:string,@Body() dto:UpdateUserDto,@CurrentUser() me:{id:string}){
  const target=await this.db.user.findUnique({where:{id}});
  if(!target)throw new NotFoundException('User not found');
  if(dto.active===false){
   if(target.id===me.id)throw new BadRequestException('You cannot disable your own account');
   if(target.role===Role.OWNER){
    const activeOwners=await this.db.user.count({where:{role:Role.OWNER,active:true}});
    if(activeOwners<=1)throw new BadRequestException('Cannot disable the only active owner');
   }
  }
  if(dto.password===undefined&&dto.active===undefined)throw new BadRequestException('Nothing to update');
  return this.db.user.update({where:{id},data:{...(dto.active!==undefined?{active:dto.active}:{}),...(dto.password?{passwordHash:await hash(dto.password,12)}:{})},select:{id:true,username:true,role:true,active:true}});
 }
}
