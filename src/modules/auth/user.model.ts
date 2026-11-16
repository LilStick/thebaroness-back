import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

const userSchema = new Schema(
  {
    // Normalisé (trim + minuscules) avant écriture ; unicité garantie par l'index.
    email: { type: String, required: true, lowercase: true, trim: true },
    // Seul le hash bcrypt est stocké ; jamais sélectionné par défaut.
    passwordHash: { type: String, required: true, select: false },
  },
  { collection: 'users', timestamps: true, versionKey: false, strict: 'throw' },
);

userSchema.index({ email: 1 }, { unique: true });

export type UserFields = InferSchemaType<typeof userSchema> & { _id: Types.ObjectId };

export const UserModel = model('User', userSchema);

export interface PublicUser {
  id: string;
  email: string;
}

export const toPublicUser = (user: Pick<UserFields, '_id' | 'email'>): PublicUser => ({
  id: user._id.toHexString(),
  email: user.email,
});
