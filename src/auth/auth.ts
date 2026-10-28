import { Body, Controller, Get, Post, Injectable, UnauthorizedException } from '@nestjs/common';
import { IsString, MinLength } from 'class-validator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { compare } from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Public } from '../common/auth';
class LoginDto { @IsString() username!:string; @IsString() @MinLength(1) password!:string; }
@Injectable()
export class AuthService {
 constructor(private db:PrismaService,private jwt:JwtService){}
 async login(dto:LoginDto){const user=await this.db.user.findUnique({where:{username:dto.username}});
  if(!user?.active || !(await compare(dto.password,user.passwordHash)))throw new UnauthorizedException('Invalid credentials');
  return {accessToken:await this.jwt.signAsync({sub:user.id,role:user.role}),user:{id:user.id,username:user.username,role:user.role}};
 }
}
@ApiTags('Authentication') @Controller('auth')
export class AuthController {
 constructor(private auth:AuthService,private db:PrismaService){}
 @Public() @Post('login') login(@Body() dto:LoginDto){return this.auth.login(dto);}
 @ApiBearerAuth() @Get('me') me(@CurrentUser() user:{id:string}){return this.db.user.findUnique({where:{id:user.id},select:{id:true,username:true,role:true,active:true}});}
}
