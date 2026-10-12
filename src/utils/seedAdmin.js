import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { User } from '../models/index.js';

await mongoose.connect(process.env.MONGODB_URI);
const email = process.env.ADMIN_EMAIL, password = process.env.ADMIN_PASSWORD;
if (!email || !password) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD');
await User.updateOne({ email: email.toLowerCase() },
  { $set: { name: 'Platform Admin', role: 'admin', emailVerified: true, status: 'active', passwordHash: await bcrypt.hash(password, 12) } },
  { upsert: true });
console.log('Admin ready:', email);
await mongoose.disconnect();
