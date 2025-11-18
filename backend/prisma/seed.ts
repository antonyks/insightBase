import { prisma } from '../src/config/database';
import bcrypt from 'bcryptjs';

async function main() {
  console.log('Seeding database...');

  const users = [
    { name: 'Admin User', email: 'admin@example.com', password: 'Admin123!', role: 'ADMIN' },
    { name: 'Regular User', email: 'user@example.com', password: 'User123!', role: 'USER' },
  ];

  for (const u of users) {
    const hashedPassword = await bcrypt.hash(u.password, 10);

    await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: {
        name: u.name,
        email: u.email,
        passwordHash: hashedPassword,
        role: u.role as 'USER' | 'ADMIN',
      },
    });

    console.log(`User ${u.email} seeded`);
  }

  console.log('Database seeding completed.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
