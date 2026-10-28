import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
try {
  await prisma.$connect();
  const n = await prisma.user.count();
  console.log('OK users=', n);
} catch (e) {
  console.error('FAIL', e.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
