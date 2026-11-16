import { z } from 'zod';
import { steamIdInputSchema } from '../../shared/schemas';
import { TRACKED_PLAYER_LIMITS as L } from './tracked-player.model';

const alias = z.string().trim().max(L.aliasMax, `alias : ${L.aliasMax} caractères maximum`);
const note = z.string().trim().max(L.noteMax, `note : ${L.noteMax} caractères maximum`);
const tags = z
  .array(
    z
      .string()
      .trim()
      .min(L.tagMin, 'tags : un tag ne peut pas être vide')
      .max(L.tagMax, `tags : ${L.tagMax} caractères maximum par tag`),
  )
  .max(L.tagsMax, `tags : ${L.tagsMax} tags maximum`)
  .refine((values) => new Set(values).size === values.length, 'tags : doublons interdits');

/** Création : `steamId` requis ; `id`, `ownerId`, timestamps et champs inconnus refusés (strict). */
export const createTrackedPlayerSchema = z.strictObject({
  steamId: steamIdInputSchema,
  alias: alias.optional(),
  note: note.optional(),
  tags: tags.optional(),
});

/** Modification partielle : au moins un champ, `steamId` immuable. */
export const updateTrackedPlayerSchema = z
  .strictObject({ alias: alias.optional(), note: note.optional(), tags: tags.optional() })
  .refine((body) => Object.keys(body).length > 0, 'Au moins un champ à modifier est requis');

export type CreateTrackedPlayerInput = z.infer<typeof createTrackedPlayerSchema>;
export type UpdateTrackedPlayerInput = z.infer<typeof updateTrackedPlayerSchema>;
