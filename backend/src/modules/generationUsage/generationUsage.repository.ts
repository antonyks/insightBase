import { Prisma } from '@prisma/client';
import { GenerationUsageModel, GenerationUsageSelectFields, SelectedGenerationUsage } from './generationUsage.model';

export const GenerationUsageRepository = {
  async create(data: Prisma.GenerationUsageUncheckedCreateInput): Promise<SelectedGenerationUsage> {
    return GenerationUsageModel.create({
      data,
      select: GenerationUsageSelectFields,
    });
  },
};
