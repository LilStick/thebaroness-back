import { AppError, notFound } from '../../shared/errors';
import { isDuplicateKeyError } from '../../shared/mongo-errors';
import {
  TrackedPlayerModel,
  toTrackedPlayerDto,
  type TrackedPlayerDto,
} from './tracked-player.model';
import type { CreateTrackedPlayerInput, UpdateTrackedPlayerInput } from './tracked-player.schemas';

const trackedNotFound = () => notFound('Suivi introuvable.');

/**
 * Toutes les opérations filtrent sur `ownerId` dans la requête MongoDB elle-même (§13.4) :
 * l'objet d'un autre compte est indiscernable d'un objet inexistant (404).
 */
export const trackedPlayerService = {
  async list(ownerId: string): Promise<TrackedPlayerDto[]> {
    const docs = await TrackedPlayerModel.find({ ownerId }).sort({ updatedAt: -1, _id: -1 }).lean();
    return docs.map(toTrackedPlayerDto);
  },

  async get(ownerId: string, id: string): Promise<TrackedPlayerDto> {
    const doc = await TrackedPlayerModel.findOne({ _id: id, ownerId }).lean();
    if (!doc) throw trackedNotFound();
    return toTrackedPlayerDto(doc);
  },

  async create(ownerId: string, input: CreateTrackedPlayerInput): Promise<TrackedPlayerDto> {
    try {
      const doc = await TrackedPlayerModel.create({ ...input, ownerId });
      return toTrackedPlayerDto(doc);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new AppError(409, 'ALREADY_TRACKED', 'Ce joueur est déjà dans votre liste.');
      }
      throw error;
    }
  },

  async update(
    ownerId: string,
    id: string,
    input: UpdateTrackedPlayerInput,
  ): Promise<TrackedPlayerDto> {
    const doc = await TrackedPlayerModel.findOneAndUpdate(
      { _id: id, ownerId },
      { $set: input },
      { new: true, runValidators: true },
    ).lean();
    if (!doc) throw trackedNotFound();
    return toTrackedPlayerDto(doc);
  },

  async remove(ownerId: string, id: string): Promise<void> {
    const { deletedCount } = await TrackedPlayerModel.deleteOne({ _id: id, ownerId });
    if (deletedCount === 0) throw trackedNotFound();
  },
};
