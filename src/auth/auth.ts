import { Body, Controller, Get, Post, Injectable, UnauthorizedException } from '@nestjs/common';
import { IsString, MinLength } from 'class-validator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { compare } from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import { CustomerStatus, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Public, Roles } from '../common/auth';
import { normalizeEtPhone } from '../common/phone';

class LoginDto {
  @IsString()
  username!: string;
  @IsString()
  @MinLength(1)
  password!: string;
}
class CustomerLoginDto {
  @IsString()
  @MinLength(1)
  phone!: string;
}

@Injectable()
export class AuthService {
  constructor(
    private db: PrismaService,
    private jwt: JwtService,
  ) {}
  async login(dto: LoginDto) {
    const user = await this.db.user.findUnique({ where: { username: dto.username } });
    if (!user?.active || !(await compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return {
      accessToken: await this.jwt.signAsync({ sub: user.id, role: user.role }),
      user: { id: user.id, username: user.username, role: user.role },
    };
  }
  async customerLogin(dto: CustomerLoginDto) {
    const phone = normalizeEtPhone(dto.phone);
    if (!phone) throw new UnauthorizedException('Invalid phone number');
    const raw = dto.phone.replace(/[\s\-()]/g, '');
    const customer = await this.db.customer.findFirst({
      where: {
        status: CustomerStatus.ACTIVE,
        phone: { in: [phone, raw].filter((v, i, a) => v && a.indexOf(v) === i) as string[] },
      },
    });
    if (!customer) {
      throw new UnauthorizedException('No active account found for this phone number');
    }
    return {
      accessToken: await this.jwt.signAsync({ sub: customer.id, role: Role.CUSTOMER }),
      user: { id: customer.id, name: customer.name, phone: customer.phone, role: Role.CUSTOMER },
    };
  }
}

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(
    private auth: AuthService,
    private db: PrismaService,
  ) {}
  @Public()
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }
  @Public()
  @Post('customer-login')
  customerLogin(@Body() dto: CustomerLoginDto) {
    return this.auth.customerLogin(dto);
  }
  @ApiBearerAuth()
  @Roles(Role.OWNER, Role.CASHIER, Role.CUSTOMER)
  @Get('me')
  async me(@CurrentUser() user: { id: string; role: Role }) {
    if (user.role === Role.CUSTOMER) {
      const customer = await this.db.customer.findUnique({
        where: { id: user.id },
        select: { id: true, name: true, phone: true, status: true },
      });
      if (!customer || customer.status !== CustomerStatus.ACTIVE) {
        throw new UnauthorizedException('Session invalid — sign in again');
      }
      return { id: customer.id, name: customer.name, phone: customer.phone, role: Role.CUSTOMER };
    }
    return this.db.user.findUnique({
      where: { id: user.id },
      select: { id: true, username: true, role: true, active: true },
    });
  }
}
