import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { shopmonkeyRequest, fetchAllRecords, sanitizePathParam, getDefaultLocationId, isWithinDateRange } from '../client.js';
import type { Appointment } from '../types/shopmonkey.js';
import type { ToolHandlerMap } from '../types/tools.js';
import { pickFields } from '../types/tools.js';

export const definitions: Tool[] = [
  {
        name: 'list_appointments',
        description: 'List appointments from Shopmonkey. Supports filtering and pagination. Date-filtered queries page through up to 500 records server-side to ensure a complete, stable result.',
        inputSchema: {
                type: 'object' as const,
                properties: {
                          customerId: { type: 'string', description: 'Filter appointments by customer ID' },
                          locationId: { type: 'string', description: 'Filter by location ID. Defaults to SHOPMONKEY_LOCATION_ID env var if set.' },
                          startDate: { type: 'string', description: 'Filter by start date (ISO 8601 format)' },
                          endDate: { type: 'string', description: 'Filter by end date (ISO 8601 format)' },
                          limit: { type: 'number', description: 'Maximum number of results to return (default: 25)' },
                          skip: { type: 'number', description: 'Number of records to skip for pagination (default: 0)' },
                },
        },
  },
  {
        name: 'get_appointment',
        description: 'Get detailed information about a single appointment by its ID.',
        inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'The appointment ID' } }, required: ['id'] },
  },
  {
        name: 'create_appointment',
        description: 'Book a new appointment in Shopmonkey.',
        inputSchema: {
                type: 'object' as const,
                properties: {
                          customerId: { type: 'string', description: 'Customer ID for the appointment' },
                          vehicleId: { type: 'string', description: 'Vehicle ID for the appointment' },
                          orderId: { type: 'string', description: 'Work order ID to link to' },
                          startDate: { type: 'string', description: 'Appointment start date/time (ISO 8601 format)' },
                          endDate: { type: 'string', description: 'Appointment end date/time (ISO 8601 format)' },
                          title: { type: 'string', description: 'Appointment title or summary' },
                          notes: { type: 'string', description: 'Additional notes for the appointment' },
                          locationId: { type: 'string', description: 'Location ID for multi-location shops. Defaults to SHOPMONKEY_LOCATION_ID env var if set.' },
                },
        },
  },
  {
        name: 'update_appointment',
        description: 'Update or reschedule an existing appointment.',
        inputSchema: {
                type: 'object' as const,
                properties: {
                          id: { type: 'string', description: 'The appointment ID to update' },
                          customerId: { type: 'string', description: 'Customer ID for the appointment' },
                          vehicleId: { type: 'string', description: 'Vehicle ID for the appointment' },
                          orderId: { type: 'string', description: 'Work order ID to link to' },
                          startDate: { type: 'string', description: 'New start date/time (ISO 8601 format)' },
                          endDate: { type: 'string', description: 'New end date/time (ISO 8601 format)' },
                          title: { type: 'string', description: 'Appointment title or summary' },
                          notes: { type: 'string', description: 'Additional notes' },
                },
                required: ['id'],
        },
  },
  ];

const CREATE_FIELDS = ['customerId', 'vehicleId', 'orderId', 'startDate', 'endDate', 'title', 'notes', 'locationId'];
const UPDATE_FIELDS = ['customerId', 'vehicleId', 'orderId', 'startDate', 'endDate', 'title', 'notes'];

function applyDefaultLocation(params: Record<string, string>): void {
    if (!params.locationId) {
          const defaultId = getDefaultLocationId();
          if (defaultId) params.locationId = defaultId;
    }
}

export const handlers: ToolHandlerMap = {
    async list_appointments(args) {
          const hasDateFilter = args.startDate !== undefined || args.endDate !== undefined;
          const requestedLimit = args.limit !== undefined ? Number(args.limit) : 25;

      const params: Record<string, string> = {};
          if (args.customerId !== undefined) params.customerId = String(args.customerId);
          if (args.locationId !== undefined) params.locationId = String(args.locationId);
          applyDefaultLocation(params);

      if (hasDateFilter) {
              // Shopmonkey's /appointment endpoint does not reliably filter by date
            // server-side (verified against the live API: neither flat startDate/
            // endDate params nor a `where` clause worked). A single capped fetch
            // also isn't stable across calls — identical requests seconds apart
            // returned different, sometimes non-overlapping subsets of
            // appointments when verified live. So when a date filter is
            // requested we page through up to 500 records via fetchAllRecords
            // (see client.ts) and filter client-side against the appointment's
            // own startDate — see isWithinDateRange in client.ts.
            const { records: fetched } = await fetchAllRecords<Appointment>('/appointment', params, { maxRecords: 500 });
              const data = fetched
                .filter(a => isWithinDateRange(
                            String(a.startDate ?? ''),
                            args.startDate !== undefined ? String(args.startDate) : undefined,
                            args.endDate !== undefined ? String(args.endDate) : undefined
                          ))
                .slice(0, requestedLimit);

            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      // No date filter: normal single-page pagination via limit/skip.
      if (args.limit !== undefined) params.limit = String(args.limit);
          if (args.skip !== undefined) params.skip = String(args.skip);

      const data = await shopmonkeyRequest<Appointment[]>('GET', '/appointment', undefined, params);

      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },

    async get_appointment(args) {
          if (!args.id) return { content: [{ type: 'text', text: 'Error: id is required' }], isError: true };
          const data = await shopmonkeyRequest<Appointment>('GET', `/appointment/${sanitizePathParam(String(args.id))}`);
          return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },

    async create_appointment(args) {
          const body = pickFields(args, CREATE_FIELDS);
          if (!body.locationId) {
                  const defaultId = getDefaultLocationId();
                  if (defaultId) body.locationId = defaultId;
          }
          const data = await shopmonkeyRequest<Appointment>('POST', '/appointment', body);
          return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },

    async update_appointment(args) {
          if (!args.id) return { content: [{ type: 'text', text: 'Error: id is required' }], isError: true };
          const body = pickFields(args, UPDATE_FIELDS);
          const data = await shopmonkeyRequest<Appointment>('PUT', `/appointment/${sanitizePathParam(String(args.id))}`, body);
          return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
};
