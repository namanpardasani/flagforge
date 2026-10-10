import { prisma } from "../db.js";

try {
  const count = await prisma.user.count();
  console.log(`DB connection OK. User count: ${count}`);
} finally {
  await prisma.$disconnect();
}
