import { z } from 'zod';
import { steamIdSchema } from '../../shared/schemas';
import { GROUP_LIMITS as L } from './group.model';

const name = z
  .string()
  .trim()
  .min(1, 'name : requis')
  .max(L.nameMax, `name : ${L.nameMax} caractères maximum`);

const steamIds = z
  .array(steamIdSchema)
  .min(L.membersMin, `steamIds : ${L.membersMin} joueurs minimum`)
  .max(L.membersMax, `steamIds : ${L.membersMax} joueurs maximum`)
  .refine((ids) => new Set(ids).size === ids.length, 'steamIds : doublons interdits');

export const createGroupSchema = z.strictObject({ name, steamIds });

export const updateGroupSchema = z
  .strictObject({ name: name.optional(), steamIds: steamIds.optional() })
  .refine((body) => Object.keys(body).length > 0, 'Au moins un champ à modifier est requis');

export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;
