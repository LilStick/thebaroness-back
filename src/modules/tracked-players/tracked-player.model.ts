import { Schema, model, type HydratedDocument, type InferSchemaType, type Types } from 'mongoose';

export const TRACKED_PLAYER_LIMITS = {
  aliasMax: 80,
  noteMax: 1000,
  tagsMax: 10,
  tagMin: 1,
  tagMax: 24,
} as const;

const trackedPlayerSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // SteamID64 conservé en chaîne : il dépasse Number.MAX_SAFE_INTEGER (§7.2).
    steamId: { type: String, required: true, immutable: true, match: /^\d{17}$/ },
    alias: { type: String, default: '', maxlength: TRACKED_PLAYER_LIMITS.aliasMax },
    note: { type: String, default: '', maxlength: TRACKED_PLAYER_LIMITS.noteMax },
    tags: { type: [String], default: [] },
  },
  {
    collection: 'tracked_players',
    timestamps: true,
    versionKey: false,
    strict: 'throw',
  },
);

// Un même compte ne suit pas deux fois le même joueur ; deux comptes différents le peuvent.
trackedPlayerSchema.index({ ownerId: 1, steamId: 1 }, { unique: true });
// Liste « Mes suivis » triée par dernière modification.
trackedPlayerSchema.index({ ownerId: 1, updatedAt: -1 });

export type TrackedPlayerFields = InferSchemaType<typeof trackedPlayerSchema> & {
  _id: Types.ObjectId;
};
export type TrackedPlayerDocument = HydratedDocument<TrackedPlayerFields>;

export const TrackedPlayerModel = model('TrackedPlayer', trackedPlayerSchema);

/** DTO public (§19.4 D) : jamais d'`ownerId`, de `_id` ni de champ interne. */
export interface TrackedPlayerDto {
  id: string;
  steamId: string;
  alias: string;
  note: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export function toTrackedPlayerDto(doc: TrackedPlayerFields): TrackedPlayerDto {
  return {
    id: doc._id.toHexString(),
    steamId: doc.steamId,
    alias: doc.alias,
    note: doc.note,
    tags: [...doc.tags],
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
