import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

const userSchema = new Schema(
  {
    // SteamID64 (17 chiffres) conservé en chaîne : dépasse Number.MAX_SAFE_INTEGER.
    steamId: { type: String, required: true, immutable: true, match: /^\d{17}$/ },
    // Copie du profil Steam, rafraîchie à chaque connexion (repli : le steamId).
    displayName: { type: String, required: true },
    avatarUrl: { type: String, default: null },
    lastLoginAt: { type: Date, required: true },
  },
  { collection: 'users', timestamps: true, versionKey: false, strict: 'throw' },
);

userSchema.index({ steamId: 1 }, { unique: true });

export type UserFields = InferSchemaType<typeof userSchema> & { _id: Types.ObjectId };

export const UserModel = model('User', userSchema);

/** Utilisateur exposé au front (contrat `back-steam-contract.md`). */
export interface PublicUser {
  id: string;
  steamId: string;
  displayName: string;
  avatarUrl: string | null;
}

export const toPublicUser = (
  user: Pick<UserFields, '_id' | 'steamId' | 'displayName' | 'avatarUrl'>,
): PublicUser => ({
  id: user._id.toHexString(),
  steamId: user.steamId,
  displayName: user.displayName,
  avatarUrl: user.avatarUrl ?? null,
});
