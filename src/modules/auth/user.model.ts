import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

const userSchema = new Schema(
  {
    // SteamID64 (17 chiffres) conservé en chaîne : dépasse Number.MAX_SAFE_INTEGER.
    steamId: { type: String, required: true, immutable: true, match: /^\d{17}$/ },
    lastLoginAt: { type: Date, required: true },
  },
  { collection: 'users', timestamps: true, versionKey: false, strict: 'throw' },
);

userSchema.index({ steamId: 1 }, { unique: true });

export type UserFields = InferSchemaType<typeof userSchema> & { _id: Types.ObjectId };

export const UserModel = model('User', userSchema);

export interface PublicUser {
  id: string;
  steamId: string;
}

export const toPublicUser = (user: Pick<UserFields, '_id' | 'steamId'>): PublicUser => ({
  id: user._id.toHexString(),
  steamId: user.steamId,
});
