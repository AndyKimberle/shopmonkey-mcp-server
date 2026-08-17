import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePathParam, getDefaultLocationId, fetchAllRecords } from '../client.js';
import { pickFields } from '../types/tools.js';

describe('sanitizePathParam', () => {
    it('encodes special characters', () => {
          assert.equal(sanitizePathParam('abc?foo=bar'), 'abc%3Ffoo%3Dbar');
    });

           it('encodes slashes to prevent path traversal', () => {
                 assert.equal(sanitizePathParam('../../admin'), '..%2F..%2Fadmin');
           });

           it('encodes hash characters', () => {
                 assert.equal(sanitizePathParam('abc#fragment'), 'abc%23fragment');
           });

           it('passes through normal IDs unchanged', () => {
                 assert.equal(sanitizePathParam('abc123'), 'abc123');
           });

           it('handles UUIDs', () => {
                 const uuid = '550e8400-e29b-41d4-a716-446655440000';
                 assert.equal(sanitizePathParam(uuid), uuid);
           });
});

describe('pickFields', () => {
    it('picks only allowed fields', () => {
          const result = pickFields(
            { name: 'John', email: 'john@test.com', secret: 'hack' },
                  ['name', 'email']
                );
          assert.deepEqual(result, { name: 'John', email: 'john@test.com' });
    });

           it('ignores undefined values', () => {
                 const result = pickFields(
                   { name: 'John', email: undefined },
                         ['name', 'email']
                       );
                 assert.deepEqual(result, { name: 'John' });
           });

           it('preserves falsy values like 0 and empty string', () => {
                 const result = pickFields(
                   { count: 0, label: '', active: false },
                         ['count', 'label', 'active']
                       );
                 assert.deepEqual(result, { count: 0, label: '', active: false });
           });

           it('returns empty object when no allowed fields present', () => {
                 const result = pickFields({ secret: 'hack' }, ['name', 'email']);
                 assert.deepEqual(result, {});
           });
});

describe('getDefaultLocationId', () => {
    const originalEnv = process.env.SHOPMONKEY_LOCATION_ID;

           after(() => {
                 if (originalEnv !== undefined) {
                         process.env.SHOPMONKEY_LOCATION_ID = originalEnv;
                 } else {
                         delete process.env.SHOPMONKEY_LOCATION_ID;
                 }
           });

           it('returns undefined when not set', () => {
                 delete process.env.SHOPMONKEY_LOCATION_ID;
                 assert.equal(getDefaultLocationId(), undefined);
           });

           it('returns undefined when empty string', () => {
                 process.env.SHOPMONKEY_LOCATION_ID = '';
                 assert.equal(getDefaultLocationId(), undefined);
           });

           it('returns the value when set', () => {
                 process.env.SHOPMONKEY_LOCATION_ID = 'loc-123';
                 assert.equal(getDefaultLocationId(), 'loc-123');
           });
});

describe('fetchAllRecords', () => {
    const originalFetch = globalThis.fetch;
    let capturedUrls: string[] = [];

           beforeEach(() => { process.env.SHOPMONKEY_API_KEY = 'test-key-123'; });
    afterEach(() => { globalThis.fetch = originalFetch; delete process.env.SHOPMONKEY_API_KEY; });

           function mockPages(pages: unknown[][]) {
                 capturedUrls = [];
                 let call = 0;
                 globalThis.fetch = (async (input: string | URL | Request) => {
                         const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
                         capturedUrls.push(url);
                         const page = pages[Math.min(call, pages.length - 1)];
                         call++;
                         const body = { success: true, data: page };
                         return new Response(JSON.stringify(body), {
                                   status: 200,
                                   headers: { 'content-length': String(JSON.stringify(body).length) },
                         });
                 }) as typeof fetch;
           }

           it('stops after a single short page (fewer records than pageSize)', async () => {
                 mockPages([[{ id: '1' }, { id: '2' }]]);
                 const { records, truncated } = await fetchAllRecords('/order', undefined, { pageSize: 100, maxRecords: 500 });
                 assert.equal(records.length, 2);
                 assert.equal(truncated, false);
                 assert.equal(capturedUrls.length, 1);
           });

           it('pages through multiple full pages until a short page is returned', async () => {
                 const page1 = Array.from({ length: 3 }, (_, i) => ({ id: `p1-${i}` }));
                 const page2 = Array.from({ length: 3 }, (_, i) => ({ id: `p2-${i}` }));
                 const page3 = [{ id: 'last' }]; // short page: signals end
                  mockPages([page1, page2, page3]);

                  const { records, truncated } = await fetchAllRecords('/order', undefined, { pageSize: 3, maxRecords: 500 });
                 assert.equal(records.length, 7);
                 assert.equal(truncated, false);
                 assert.equal(capturedUrls.length, 3);
                 assert.ok(capturedUrls[0].includes('skip=0'));
                 assert.ok(capturedUrls[1].includes('skip=3'));
                 assert.ok(capturedUrls[2].includes('skip=6'));
           });

           it('stops and marks truncated once maxRecords is reached', async () => {
                 // Distinct ids per page so dedup doesn't collapse the count — this
      // simulates a shop with more matching records than the cap allows.
                  const page1 = Array.from({ length: 3 }, (_, i) => ({ id: `p1-${i}` }));
                 const page2 = Array.from({ length: 3 }, (_, i) => ({ id: `p2-${i}` }));
                 mockPages([page1, page2, page1, page2]);

                  const { records, truncated } = await fetchAllRecords('/order', undefined, { pageSize: 3, maxRecords: 6 });
                 assert.equal(records.length, 6);
                 assert.equal(truncated, true);
                 assert.equal(capturedUrls.length, 2);
           });

           it('terminates without hanging even if every page returns the same duplicate records', async () => {
                 // Regression test: if the underlying API returns overlapping records
                  // across pages (the same instability fetchAllRecords exists to work
                  // around), dedup must not stall the loop's termination condition —
                  // it's bounded by raw records fetched (skip), not the deduped count.
                  const samePage = Array.from({ length: 3 }, (_, i) => ({ id: `dup-${i}` }));
                 mockPages([samePage, samePage, samePage, samePage, samePage]);

                  const { records, truncated } = await fetchAllRecords('/order', undefined, { pageSize: 3, maxRecords: 9 });
                 assert.equal(records.length, 3); // only 3 distinct ids ever appear
                  assert.equal(truncated, true); // stopped because the cap was hit, not because data ran out
                  assert.equal(capturedUrls.length, 3); // 3 pages * pageSize 3 = 9 = maxRecords
           });

           it('deduplicates records that appear across pages by id', async () => {
                 const page1 = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
                 const page2 = [{ id: 'b' }, { id: 'c' }, { id: 'd' }]; // overlap from reordering
                  const page3 = [{ id: 'e' }]; // short: end
                  mockPages([page1, page2, page3]);

                  const { records } = await fetchAllRecords('/order', undefined, { pageSize: 3, maxRecords: 500 });
                 const ids = records.map((r) => (r as { id: string }).id);
                 assert.deepEqual(ids, ['a', 'b', 'c', 'd', 'e']);
           });

           it('returns empty result and stops on an empty first page', async () => {
                 mockPages([[]]);
                 const { records, truncated } = await fetchAllRecords('/order');
                 assert.equal(records.length, 0);
                 assert.equal(truncated, false);
                 assert.equal(capturedUrls.length, 1);
           });

           it('passes through caller params on every page request', async () => {
                 mockPages([[{ id: '1' }]]);
                 await fetchAllRecords('/appointment', { locationId: 'loc-1' }, { pageSize: 50 });
                 assert.ok(capturedUrls[0].includes('locationId=loc-1'));
           });
});
