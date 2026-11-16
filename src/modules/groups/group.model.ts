import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

export const GROUP_LIMITS = { nameMax: 60, membersMin: 2, membersMax: 20 } as const;

const groupSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, minlength: 1, maxlength: GROUP_LIMITS.nameMax },
    // SteamID64 en chaînes (précision), ordre choisi par l'utilisateur conservé.
    steamIds: { type: [{ type: String, match: /^\d{17}$/ }], required: true },
  },
  { collection: 'groups', timestamps: true, versionKey: false, strict: 'throw' },
);

// Liste « Mes groupes » d'un compte, du plus récemment modifié au plus ancien.
groupSchema.index({ ownerId: 1, updatedAt: -1 });

export type GroupFields = InferSchemaType<typeof groupSchema> & { _id: Types.ObjectId };

export const GroupModel = model('Group', groupSchema);

/** DTO public (contrat back-groups-contract.md) : jamais d'`ownerId`. */
export interface GroupDto {
  id: string;
  name: string;
  steamIds: string[];
  createdAt: string;
  updatedAt: string;
}

export const toGroupDto = (doc: GroupFields): GroupDto => ({
  id: doc._id.toHexString(),
  name: doc.name,
  steamIds: [...doc.steamIds],
  createdAt: doc.createdAt.toISOString(),
  updatedAt: doc.updatedAt.toISOString(),
});
