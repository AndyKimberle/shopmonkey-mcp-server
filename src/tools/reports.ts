// Composite report tools aggregate Shopmonkey list endpoints client-side.
// Shopmonkey has no native /report endpoint — these tools compose the data from
// existing list endpoints (Option B, confirmed with client). Reports paginate
// through up to 1500 records per call (see fetchAllRecords in client.ts); use a
// tighter date range for very high-volume shops. Even at 1500, a shop with more
// total orders than that may still see an undercount for older date ranges —
// the `truncated` field in the response signals when this happened. There is
// no dedicated /order/search endpoint (checked against Shopmonkey's docs), so
// unlike appointments, orders can't get a fully reliable server-side date
// filter — see docs/LIMITATIONS.md.
// All tools return raw JSON (not Markdown) for downstream processing flexibility.
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { fetchAllRecords, getDefaultLocationId, isWithinDateRange, shopmonkeyRequest, toDateRangeBoundary } from '../client.js';
import type { Order, Appointment } from '../types/shopmonkey.js';
import type { ToolHandlerMap } from '../types/tools.js';

export const definitions: Tool[] = [
  {
            name: 'report_revenue_summary',
            description: 'Generate a revenue summary report for orders invoiced within a date range (filters on invoicedDate, not order creation date). Aggregates by status and splits paid vs. unpaid revenue. Paginates through up to 1500 orders — use a tighter date range for very high-volume shops, and check the `truncated` field.',
            inputSchema: {
                              type: 'object' as const,
                              properties: {
                                                          startDate: { type: 'string', description: 'Start date in ISO 8601 format (e.g., "2026-04-01")' },
                                                          endDate: { type: 'string', description: 'End date in ISO 8601 format (e.g., "2026-04-30")' },
                                                          locationId: { type: 'string', description: 'Filter by location ID. Defaults to SHOPMONKEY_LOCATION_ID env var if set.' },
                              },
                              required: ['startDate', 'endDate'],
            },
  },
  {
            name: 'report_appointment_summary',
            description: 'Generate an appointment summary report for a date range. Counts appointments by confirmation status (Confirmed/Declined/NoResponse). Uses the /appointment/search endpoint for a reliable server-side date filter.',
            inputSchema: {
                              type: 'object' as const,
                              properties: {
                                                          startDate: { type: 'string', description: 'Start date in ISO 8601 format (e.g., "2026-04-01")' },
                                                          endDate: { type: 'string', description: 'End date in ISO 8601 format (e.g., "2026-04-30")' },
                                                          locationId: { type: 'string', description: 'Filter by location ID. Defaults to SHOPMONKEY_LOCATION_ID env var if set.' },
                              },
                              required: ['startDate', 'endDate'],
            },
  },
  {
            name: 'report_open_estimates',
            description: 'List all open (unauthorized) estimates, showing their age in days. Useful for follow-up on stale estimates. Paginates through up to 1500 records.',
            inputSchema: {
                              type: 'object' as const,
                              properties: {
                                                          locationId: { type: 'string', description: 'Filter by location ID. Defaults to SHOPMONKEY_LOCATION_ID env var if set.' },
                              },
            },
  },
    ];

function getDefaultLocParam(): Record<string, string> {
      const params: Record<string, string> = {};
      const defaultId = getDefaultLocationId();
      if (defaultId) params.locationId = defaultId;
      return params;
}

export const handlers: ToolHandlerMap = {
      async report_revenue_summary(args) {
                  if (!args.startDate) return { content: [{ type: 'text', text: 'Error: startDate is required' }], isError: true };
                  if (!args.endDate) return { content: [{ type: 'text', text: 'Error: endDate is required' }], isError: true };

        const params = getDefaultLocParam();
                  if (args.locationId !== undefined) params.locationId = String(args.locationId);
                  // Shopmonkey's /order endpoint does not reliably filter by date
        // server-side (verified against the live API), so we filter client-side.
        // We filter on invoicedDate (when the order was actually invoiced),
        // not createdDate — "revenue invoiced this week" and "orders created
        // this week" are different questions, and an order created weeks ago
        // can be invoiced today. Orders never invoiced (invoicedDate null,
        // e.g. open Estimates) are correctly excluded from this report as a
        // result. A single capped fetch also isn't stable across calls
        // (verified live), so we page through everything via fetchAllRecords
        // instead — see client.ts for details.
        const { records: fetchedOrders, truncated } = await fetchAllRecords<Order>('/order', params, { maxRecords: 1500 });
                  const orders = fetchedOrders.filter(o => isWithinDateRange(String(o.invoicedDate ?? ''), String(args.startDate), String(args.endDate)));

        const breakdown: Record<string, { count: number; totalCostCents: number }> = {};
                  let totalCostCents = 0;
                  let paidCostCents = 0;

        for (const order of orders) {
                        const status = String(order.status ?? 'Unknown');
                        const cost = Number(order.totalCostCents ?? 0);

                    totalCostCents += cost;
                        if (order.paid) paidCostCents += cost;

                    if (!breakdown[status]) breakdown[status] = { count: 0, totalCostCents: 0 };
                        breakdown[status].count += 1;
                        breakdown[status].totalCostCents += cost;
        }

        const result = {
                        period: { startDate: args.startDate, endDate: args.endDate },
                        totals: {
                                                  totalCostCents,
                                                  paidCostCents,
                                                  unpaidCostCents: totalCostCents - paidCostCents,
                        },
                        breakdown,
                        count: orders.length,
                        truncated,
        };

        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      },

      async report_appointment_summary(args) {
                  if (!args.startDate) return { content: [{ type: 'text', text: 'Error: startDate is required' }], isError: true };
                  if (!args.endDate) return { content: [{ type: 'text', text: 'Error: endDate is required' }], isError: true };

        // Shopmonkey's flat GET /appointment list endpoint does not reliably
        // filter by date server-side (see client.ts). The dedicated POST
        // /appointment/search endpoint documents a structured
        // where.startDate.gte/lte range filter instead — use that so this
        // report reflects exactly the requested date range rather than
        // whatever happened to land in a capped client-side-filtered sweep.
        const SEARCH_LIMIT = 500;
                  const where = {
                                      startDate: {
                                                                    gte: toDateRangeBoundary(String(args.startDate), 'start'),
                                                                    lte: toDateRangeBoundary(String(args.endDate), 'end'),
                                      },
                  };
                  let appointments = await shopmonkeyRequest<Appointment[]>('POST', '/appointment/search', { where, limit: SEARCH_LIMIT });
                  const truncated = appointments.length >= SEARCH_LIMIT;

        const locationId = args.locationId !== undefined ? String(args.locationId) : getDefaultLocationId();
                  if (locationId) {
                                      appointments = appointments.filter(a => a.locationId === locationId);
                  }

        const breakdown: Record<string, { count: number }> = {
                        Confirmed: { count: 0 },
                        Declined: { count: 0 },
                        NoResponse: { count: 0 },
        };

        for (const appt of appointments) {
                        const status = String(appt.confirmationStatus ?? 'NoResponse');
                        if (breakdown[status]) {
                                                  breakdown[status].count += 1;
                        } else {
                                                  breakdown[status] = { count: 1 };
                        }
        }

        const result = {
                        period: { startDate: args.startDate, endDate: args.endDate },
                        totals: { count: appointments.length },
                        breakdown,
                        truncated,
        };

        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      },

      async report_open_estimates(args) {
                  const params = getDefaultLocParam();
                  if (args.locationId !== undefined) params.locationId = String(args.locationId);
                  params.status = 'Estimate';

        const { records: orders, truncated } = await fetchAllRecords<Order>('/order', params, { maxRecords: 1500 });

        const now = new Date();
                  const openEstimates = orders
                    .filter(o => o.authorized === false)
                    .map(o => {
                                            const created = o.createdDate ? new Date(String(o.createdDate)) : null;
                                            const ageInDays = created ? Math.floor((now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24)) : null;
                                            return { ...o, ageInDays };
                    });

        const oldestAgeInDays = openEstimates.reduce((max, o) => {
                        const age = o.ageInDays ?? 0;
                        return age > max ? age : max;
        }, 0);

        const result = {
                        orders: openEstimates,
                        count: openEstimates.length,
                        oldestAgeInDays,
                        truncated,
        };

        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      },
};
