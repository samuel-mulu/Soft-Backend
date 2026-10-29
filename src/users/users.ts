import { Body, Controller, Get, Injectable, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { Role } from '@prisma/client';
import { hash } from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { Roles } from '../common/auth';
const STAFF_ROLES = [Role.OWNER, Role.CASHIER] as const;
class CreateUserDto { @IsString() username!:string; @IsString() @MinLength(4) password!:string; @IsIn(STAFF_ROLES) role!:Role; }
class UpdateUserDto { @IsOptional() @IsBoolean() active?:boolean; @IsOptional() @IsString() @MinLength(4) password?:string; }
@ApiTags('Users') @ApiBearerAuth() @Roles(Role.OWNER) @Controller('users')
export class UsersController {
 constructor(private db:PrismaService){}
 @Get() list(){return this.db.user.findMany({select:{id:true,username:true,role:true,active:true,createdAt:true}});}
 @Post() async create(@Body() dto:CreateUserDto){return this.db.user.create({data:{username:dto.username,passwordHash:await hash(dto.password,12),role:dto.role},select:{id:true,username:true,role:true,active:true}});}
 @Patch(':id') async update(@Param('id') id:string,@Body() dto:UpdateUserDto){return this.db.user.update({where:{id},data:{active:dto.active,...(dto.password?{passwordHash:await hash(dto.password,12)}:{})},select:{id:true,username:true,role:true,active:true}});}
}
