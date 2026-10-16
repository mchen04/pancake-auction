import { internalMutationGeneric, internalQueryGeneric, mutationGeneric, queryGeneric } from 'convex/server';
import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server';
import type { DataModel } from './dataModel';
import type { MutationBuilder, QueryBuilder } from 'convex/server';

export const mutation: MutationBuilder<DataModel, 'public'> = mutationGeneric;
export const query: QueryBuilder<DataModel, 'public'> = queryGeneric;
export const internalMutation: MutationBuilder<DataModel, 'internal'> = internalMutationGeneric;
export const internalQuery: QueryBuilder<DataModel, 'internal'> = internalQueryGeneric;
export type MutationCtx = GenericMutationCtx<DataModel>;
export type QueryCtx = GenericQueryCtx<DataModel>;
