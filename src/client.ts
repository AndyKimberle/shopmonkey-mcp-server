import type { ShopmonkeyResponse } from './types/shopmonkey.js';

const RAW_BASE_URL = process.env.SHOPMONKEY_BASE_URL ?? 'https://api.shopmonkey.cloud/v3';
const BASE_URL = RAW_BASE_URL.replace(/\/+$/, '');
const MAX_RETRIES = 3;
const MAX_CONCURRENT = 5;
const REQUEST_TIMEOUT_MS = 30_000;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

let activeRequests = 0;
const requestQueue: Array<{ resolve: () => void }> = [];

async function acquireSlot(): Promise<void> {
          if (activeRequests < MAX_CONCURRENT) {
                      activeRequests++;
                      return;
          }
          return new Promise<void>((resolve) => {
                      requestQueue.push({ resolve });
          });
}

function releaseSlot(): void {
          activeRequests--;
          const next = requestQueue.shift();
          if (next) {
                      activeRequests++;
                      next.resolve();
          }
}

function getApiKey(): string {
          const key = process.env.SHOPMONKEY_API_KEY;
          if (!key) {
                      throw new Error(
                                    'SHOPMONKEY_API_KEY is not configured. ' +
                                    'Set it in your environment, .env file, or MCP client config. ' +
                                    'Create one at: Shopmonkey Settings > Integration > API Keys'
                                  );
          }
          return key;
}

export function getDefaultLocationId(): string | undefined {
          return process.env.SHOPMONKEY_LOCATION_ID || undefined;
}

async function sleep(ms: number): Promise<void> {
          return new Promise(resolve => setTimeout(resolve, ms));
}

function parseRetryAfter(header: string | null, attempt: number): number {
          if (!header) return 1000 * Math.pow(2, attempt);
          const seconds = parseInt(header, 10);
          if (!isNaN(seconds)) return seconds * 1000;
          const date = Date.parse(header);
          if (!isNaN(date)) return Math.max(0, date - Date.now());
          return 1000 * Math.pow(2, attempt);
}

export function sanitizePathParam(value: string): string {
          return encodeURIComponent(value);
}

// Shopmonkey's flat list endpoints (GET /order, GET /appointment, etc.) do NOT
// reliably honor date-range filters submitted to the API — neither flat
// `startDate`/`endDate` query params nor a Mongo-style `where` JSON param
// ({"startDate":{"$gte":...,"$lte":...}}) had any effect when verified
// against the live API: the server silently ignores the filter and returns
// its default (apparently unsorted) batch regardless of the range requested.
//
// Because of this, date-range filtering for these endpoints is done
// client-side: fetch a batch of records (as many as the API will return, up
// to our own cap) and filter them here by comparing the record's own date
// field against the requested range. This guarantees correctness for
// whatever batch was fetched, at the cost of only "seeing" the most recent
// batch — a shop with more records than the fetch cap in the requested
// range may see an undercount. See docs/LIMITATIONS.md.
export function isWithinDateRange(
          value: string | undefined | null,
          startDate?: string,
          endDate?: string
        ): boolean {
          if (!startDate && !endDate) return true;
          if (!value) return false;
          const ts = Date.parse(value);
          if (Number.isNaN(ts)) return false;
          if (startDate) {
                      const startTs = Date.parse(startDate);
                      if (!Number.isNaN(startTs) && ts < startTs) return false;
          }
          if (endDate) {
                      // Treat a date-only endDate (no time component) as inclusive of the
            // whole day, matching how startDate/endDate are typically supplied
            // (e.g. "2026-08-18" meaning "through the end of Aug 18").
            const hasTime = /T\d/.test(endDate);
                      const endTs = hasTime ? Date.parse(endDate) : Date.parse(endDate) + (24 * 60 * 60 * 1000 - 1);
                      if (!Number.isNaN(endTs) && ts > endTs) return false;
          }
          return true;
}

// Converts a caller-supplied date (which may be date-only, e.g. "2026-08-18",
// or a full ISO datetime) into an inclusive UTC range boundary, for use with
// Shopmonkey /search endpoints' structured `where.<field>.gte`/`.lte`
// filters (e.g. POST /appointment/search). A date-only value means "the
// whole day" — start of day for the 'start' edge, end of day for 'end'.
export function toDateRangeBoundary(value: string, edge: 'start' | 'end'): string {
          if (/T\d/.test(value)) return value;
          return edge === 'start' ? `${value}T00:00:00.000Z` : `${value}T23:59:59.999Z`;
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_RECORDS = 500;

/**
 * Shopmonkey's flat list endpoints do not return a stable, complete result
 * from a single capped fetch — verified empirically against the live API:
 * identical GET /appointment requests, seconds apart, returned different
 * (sometimes non-overlapping) subsets of records, including cases where a
 * record present in one response was entirely absent from the next. A
 * single "fetch up to 100 and filter client-side" call is therefore not
 * reliable for anything that needs to see every matching record.
 *
 * fetchAllRecords works around this by paginating through every available
 * page via skip/limit — the standard mechanism the API documents — until a
 * page comes back shorter than requested (the normal signal that no more
 * records remain), up to a safety cap (maxRecords) so a very large shop
 * can't trigger unbounded requests. Records are deduplicated by id in case
 * the same record appears across two pages due to reordering between
 * calls. This is slower than a single fetch but gives a complete,
 * deterministic result for any shop with fewer than maxRecords total
 * matching records — which covers realistic usage for a single-location
 * shop. See docs/LIMITATIONS.md.
 */
export async function fetchAllRecords<T extends { id?: unknown }>(
          path: string,
          params?: Record<string, string>,
          options?: { pageSize?: number; maxRecords?: number }
        ): Promise<{ records: T[]; truncated: boolean }> {
          const pageSize = options?.pageSize ?? DEFAULT_PAGE_SIZE;
          const maxRecords = options?.maxRecords ?? DEFAULT_MAX_RECORDS;

  const records: T[] = [];
          const seenIds = new Set<unknown>();
          // The loop is bounded by `skip` (total records fetched, deduped or not)
  // rather than `records.length` (post-dedup count). If the API ever
  // returns overlapping/duplicate records across pages — plausible given
  // the exact instability this function exists to work around — dedup
  // could otherwise stall records.length forever while skip keeps
  // advancing, hanging the loop. `skip` strictly increases by at least 1
  // each iteration we don't break, so this always terminates.
  let skip = 0;

  while (skip < maxRecords) {
              const remaining = maxRecords - skip;
              const limit = Math.min(pageSize, remaining);

            const page = await shopmonkeyRequest<T[]>('GET', path, undefined, {
                          ...params,
                          limit: String(limit),
                          skip: String(skip),
            });

            if (!Array.isArray(page) || page.length === 0) break;

            for (const record of page) {
                          const id = (record as { id?: unknown })?.id;
                          if (id !== undefined && seenIds.has(id)) continue;
                          if (id !== undefined) seenIds.add(id);
                          records.push(record);
            }

            skip += page.length;

            if (page.length < limit) break; // Short page: no more records remain.
  }

  const truncated = skip >= maxRecords;

  return { records, truncated };
}

export async function shopmonkeyRequest<T>(
          method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
          path: string,
          body?: Record<string, unknown>,
          params?: Record<string, string>
        ): Promise<T> {
          const apiKey = getApiKey();
          await acquireSlot();

  try {
              return await shopmonkeyRequestInner<T>(apiKey, method, path, body, params);
  } finally {
              releaseSlot();
  }
}

async function shopmonkeyRequestInner<T>(
          apiKey: string,
          method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
          path: string,
          body?: Record<string, unknown>,
          params?: Record<string, string>
        ): Promise<T> {
          let url: URL;
          try {
                      url = new URL(`${BASE_URL}${path}`);
          } catch {
                      throw new Error(`Invalid API URL: ${BASE_URL}${path}. Check SHOPMONKEY_BASE_URL configuration.`);
          }

  if (params) {
              for (const [key, value] of Object.entries(params)) {
                            if (value !== undefined && value !== '') {
                                            url.searchParams.set(key, value);
                            }
              }
  }

  const headers: Record<string, string> = {
              'Authorization': `Bearer ${apiKey}`,
  };
          if (body) {
                      headers['Content-Type'] = 'application/json';
          }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
              let response: Response;

            const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

            try {
                          response = await fetch(url.toString(), {
                                          method,
                                          headers,
                                          body: body ? JSON.stringify(body) : undefined,
                                          signal: controller.signal,
                          });
            } catch (error) {
                          if (error instanceof DOMException && error.name === 'AbortError') {
                                          lastError = new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
                          } else {
                                          lastError = error instanceof Error ? error : new Error(String(error));
                          }
                          if (attempt < MAX_RETRIES - 1) {
                                          await sleep(1000 * Math.pow(2, attempt));
                                          continue;
                          }
                          throw new Error(`Network error after ${MAX_RETRIES} attempts: ${lastError.message}`);
            } finally {
                          clearTimeout(timeoutId);
            }

            if (RETRYABLE_STATUS_CODES.has(response.status)) {
                          const retryAfter = response.headers.get('Retry-After');
                          const waitMs = parseRetryAfter(retryAfter, attempt);

                if (attempt < MAX_RETRIES - 1) {
                                await sleep(waitMs);
                                continue;
                }

                if (response.status === 429) {
                                throw new Error(
                                                  `Rate limited by Shopmonkey API after ${MAX_RETRIES} attempts. ` +
                                                  `Retry after ${retryAfter ?? 'unknown'} seconds.`
                                                );
                }
                          lastError = new Error(`Shopmonkey API returned ${response.status} after ${MAX_RETRIES} attempts`);
                          break;
            }

            if (!response.ok) {
                          const text = await response.text();
                          let errorMessage: string;
                          let errorCode: string | undefined;

                try {
                                const errorData = JSON.parse(text) as ShopmonkeyResponse<unknown>;
                                errorMessage = errorData.message ?? `HTTP ${response.status}`;
                                errorCode = errorData.code;
                } catch {
                                errorMessage = text || `HTTP ${response.status} ${response.statusText}`;
                }

                throw new Error(
                                errorCode
                                  ? `Shopmonkey API error [${errorCode}]: ${errorMessage}`
                                  : `Shopmonkey API error: ${errorMessage}`
                              );
            }

            if (response.status === 204 || response.headers.get('content-length') === '0') {
                          return undefined as T;
            }

            let data: ShopmonkeyResponse<T>;
              try {
                            data = await response.json() as ShopmonkeyResponse<T>;
              } catch {
                            throw new Error(`Invalid JSON response from Shopmonkey API (HTTP ${response.status})`);
              }

            if (!data.success) {
                          throw new Error(
                                          data.code
                                            ? `Shopmonkey API error [${data.code}]: ${data.message ?? 'Unknown error'}`
                                            : `Shopmonkey API error: ${data.message ?? 'Unknown error'}`
                                        );
            }

            if (data.data === undefined || data.data === null) {
                          throw new Error('Shopmonkey API returned success but no data');
            }

            return data.data;
  }

  throw lastError ?? new Error('Request failed after maximum retries');
}
