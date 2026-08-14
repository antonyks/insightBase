import { Prisma } from '@prisma/client';
import {
  ProviderHealthSampleModel,
  ProviderHealthSampleSelectFields,
  SelectedProviderHealthSample,
} from './providerHealthSample.model';

export const ProviderHealthSampleRepository = {
  async create(data: Prisma.ProviderHealthSampleUncheckedCreateInput): Promise<SelectedProviderHealthSample> {
    return ProviderHealthSampleModel.create({
      data,
      select: ProviderHealthSampleSelectFields,
    });
  },
};
