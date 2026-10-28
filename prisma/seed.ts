import 'dotenv/config';
import { PrismaClient, Role } from '@prisma/client';
import { hash } from 'bcryptjs';
const db=new PrismaClient();
async function main(){
 const username=process.env.SEED_OWNER_USERNAME||'owner'; const password=process.env.SEED_OWNER_PASSWORD;
 if(!password||password.length<8)throw new Error('Set SEED_OWNER_PASSWORD with at least 8 characters');
 await db.user.upsert({where:{username},create:{username,passwordHash:await hash(password,12),role:Role.OWNER},update:{}});
 console.log('Owner account available:',username);
}
main().finally(()=>db.$disconnect());
