import { z } from 'zod';

const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('email : adresse email invalide').max(254));

export const registerSchema = z.strictObject({
  email,
  // Borne haute : bcrypt ignore tout au-delà de 72 octets.
  password: z
    .string()
    .min(8, 'password : 8 caractères minimum')
    .refine((value) => Buffer.byteLength(value) <= 72, 'password : 72 octets maximum'),
});

export const loginSchema = z.strictObject({
  email,
  password: z.string().min(1, 'password : requis').max(1024),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
