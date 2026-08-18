import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { shopmonkeyRequest, sanitizePathParam } from '../client.js';
import type { Label } from '../types/shopmonkey.js';
import type { ToolHandlerMap } from '../types/tools.js';

const ENTITY_TYPES = [
    'CannedService', 'CannedServiceFee', 'CannedServiceLabor', 'CannedServicePart',
    'CannedServiceTire', 'CannedServiceSubcontract', 'Customer', 'Fee', 'Labor',
    'Order', 'Part', 'Service', 'Subcontract', 'Vehicle',
  ];

export const definitions: Tool[] = [
  {
        name: 'list_labels',
        description: 'List labels defined in Shopmonkey (e.g. custom tags like "XPEL Deal"). Optionally filter by exact name to find a specific label\'s ID before assigning it.',
        inputSchema: {
                type: 'object' as const,
                properties: {
                          name: { type: 'string', description: 'Filter to labels with this exact name' },
                          entity: { type: 'string', enum: ENTITY_TYPES, description: 'Filter to labels configured for this entity type (e.g. "Order")' },
                          limit: { type: 'number', description: 'Maximum number of results to return (default: 50)' },
                          skip: { type: 'number', description: 'Number of records to skip for pagination (default: 0)' },
                },
        },
  },
  {
        name: 'assign_label',
        description: 'Assign an existing Shopmonkey label (found via list_labels) to an entity such as an Order or Customer.',
        inputSchema: {
                type: 'object' as const,
                properties: {
                          labelId: { type: 'string', description: 'The ID of the label to assign' },
                          entity: { type: 'string', enum: ENTITY_TYPES, description: 'The type of entity to assign the label to (e.g. "Order")' },
                          entityId: { type: 'string', description: 'The ID of the entity to assign the label to' },
                },
                required: ['labelId', 'entity', 'entityId'],
        },
  },
  ];

export const handlers: ToolHandlerMap = {
    async list_labels(args) {
          const params: Record<string, string> = {};
          const where: Record<string, unknown> = {};
          if (args.name !== undefined) where.name = String(args.name);
          if (args.entity !== undefined) where.entity = String(args.entity);
          if (Object.keys(where).length > 0) params.where = JSON.stringify(where);
          if (args.limit !== undefined) params.limit = String(args.limit);
          if (args.skip !== undefined) params.skip = String(args.skip);

      const data = await shopmonkeyRequest<Label[]>('GET', '/label', undefined, params);
          return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },

    async assign_label(args) {
          if (!args.labelId) return { content: [{ type: 'text', text: 'Error: labelId is required' }], isError: true };
          if (!args.entity) return { content: [{ type: 'text', text: 'Error: entity is required' }], isError: true };
          if (!args.entityId) return { content: [{ type: 'text', text: 'Error: entityId is required' }], isError: true };

      const data = await shopmonkeyRequest<{ id: string }>(
              'PUT',
              `/label/${sanitizePathParam(String(args.labelId))}/assign`,
        { entity: String(args.entity), entityId: String(args.entityId) }
            );
          return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
};
