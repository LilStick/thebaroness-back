import { notFound } from '../../shared/errors';
import { GroupModel, toGroupDto, type GroupDto } from './group.model';
import type { CreateGroupInput, UpdateGroupInput } from './group.schemas';

const groupNotFound = () => notFound('Groupe introuvable.');

/**
 * CRUD des groupes : comme les suivis, chaque requête Mongo filtre sur `ownerId`,
 * donc le groupe d'un autre compte est indiscernable d'un groupe inexistant (404).
 */
export const groupService = {
  async list(ownerId: string): Promise<GroupDto[]> {
    const docs = await GroupModel.find({ ownerId }).sort({ updatedAt: -1, _id: -1 }).lean();
    return docs.map(toGroupDto);
  },

  async get(ownerId: string, id: string): Promise<GroupDto> {
    const doc = await GroupModel.findOne({ _id: id, ownerId }).lean();
    if (!doc) throw groupNotFound();
    return toGroupDto(doc);
  },

  async create(ownerId: string, input: CreateGroupInput): Promise<GroupDto> {
    return toGroupDto(await GroupModel.create({ ...input, ownerId }));
  },

  async update(ownerId: string, id: string, input: UpdateGroupInput): Promise<GroupDto> {
    const doc = await GroupModel.findOneAndUpdate(
      { _id: id, ownerId },
      { $set: input },
      { new: true, runValidators: true },
    ).lean();
    if (!doc) throw groupNotFound();
    return toGroupDto(doc);
  },

  async remove(ownerId: string, id: string): Promise<void> {
    const { deletedCount } = await GroupModel.deleteOne({ _id: id, ownerId });
    if (deletedCount === 0) throw groupNotFound();
  },
};
