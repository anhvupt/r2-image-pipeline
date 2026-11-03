import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lookupTenant, parseTenantConfig, siblingObjectKey, type TenantConfig } from '../src/config';
import { processQueueMessage, resultForError } from '../src/consume';
import { ImagesQuotaError } from '../src/errors';
import type { HandleDeps, ImageEncoder, ObjectHead, ObjectStore } from '../src/handle';

const DINEDL: TenantConfig = {
	tenant: 'dinedl',
	maxWidth: 1920,
	maxHeight: 1920,
	quality: 80,
	format: 'webp',
	mode: 'overwrite',
	watchPrefixes: ['tours/', 'blog/'],
	watchSuffixes: ['.jpg', '.jpeg', '.png', '.webp'],
	skipIfProcessedMeta: true,
};

function parseJsonc(text: string): unknown {
	const withoutBlock = text.replace(/\/\*[\s\S]*?\*\//g, '');
	const withoutLine = withoutBlock.replace(/^\s*\/\/.*$/gm, '');
	return JSON.parse(withoutLine);
}

function event(key: string, bucket = 'dinedl', extra: Record<string, unknown> = {}) {
	return {
		account: 'account',
		action: 'PutObject',
		bucket,
		object: { key, size: 999, eTag: 'message-etag' },
		eventTime: '2026-11-02T00:00:00.000Z',
		...extra,
	};
}

function streamFrom(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

interface FakeBucket {
	store: ObjectStore;
	puts: Array<{ key: string; bytes: Uint8Array; contentType: string; metadata: Record<string, string> }>;
	heads: number;
	gets: number;
}

function fakeBucket(head: ObjectHead | null, body = new Uint8Array([1, 2, 3])): FakeBucket {
	const puts: FakeBucket['puts'] = [];
	const state = { heads: 0, gets: 0 };
	const store: ObjectStore = {
		async head() {
			state.heads += 1;
			return head;
		},
		async get() {
			state.gets += 1;
			if (!head) return null;
			return { ...head, body: streamFrom(body) };
		},
		async put(key, value, options) {
			puts.push({
				key,
				bytes: value,
				contentType: options.httpMetadata.contentType,
				metadata: options.customMetadata,
			});
		},
	};
	return {
		store,
		puts,
		get heads() {
			return state.heads;
		},
		get gets() {
			return state.gets;
		},
	};
}

function encoder(bytes: Uint8Array, calls = { n: 0 }): ImageEncoder & { calls: { n: number } } {
	return {
		calls,
		async encode() {
			calls.n += 1;
			return bytes;
		},
	};
}

function deps(bucket: FakeBucket | undefined, images: ImageEncoder, tenants = { dinedl: DINEDL }): HandleDeps {
	return {
		tenants,
		images,
		bucketFor(name) {
			return name === 'dinedl' ? bucket?.store : undefined;
		},
	};
}

const jpegHead: ObjectHead = {
	size: 100,
	etag: 'source-etag',
	contentType: 'image/jpeg',
	customMetadata: {},
};

describe('tenant config', () => {
	it('looks up a tenant by notification bucket name', () => {
		const tenants = parseTenantConfig({ dinedl: DINEDL });
		expect(lookupTenant(tenants, 'dinedl')).toEqual(DINEDL);
		expect(lookupTenant(tenants, 'tovn')).toBeUndefined();
	});

	it('keeps the Dinedl row in wrangler.jsonc exactly as specified', () => {
		const wrangler = parseJsonc(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')) as {
			vars: { TENANT_CONFIG: Record<string, unknown> };
			r2_buckets: Array<{ binding: string; bucket_name: string }>;
		};
		expect(wrangler.vars.TENANT_CONFIG).toEqual({ dinedl: DINEDL });
		expect(wrangler.r2_buckets).toEqual([{ binding: 'dinedl', bucket_name: 'dinedl' }]);
	});
});

describe('skip rules', () => {
	it('skips keys outside the watch prefixes without reading the object', async () => {
		const bucket = fakeBucket(jpegHead);
		const images = encoder(new Uint8Array(10));
		const result = await processQueueMessage(event('other/photo.jpg'), deps(bucket, images));
		expect(result).toMatchObject({ outcome: 'ack', reason: 'prefix' });
		expect(bucket.heads).toBe(0);
		expect(bucket.puts).toEqual([]);
	});

	it('skips suffixes that are not in watchSuffixes', async () => {
		const bucket = fakeBucket(jpegHead);
		const images = encoder(new Uint8Array(10));
		const result = await processQueueMessage(event('tours/da-lat/photo.gif'), deps(bucket, images));
		expect(result).toMatchObject({ outcome: 'ack', reason: 'suffix' });
		expect(bucket.heads).toBe(0);
		expect(bucket.puts).toEqual([]);
	});

	it('skips image/gif from head metadata even when the key suffix is watched', async () => {
		const bucket = fakeBucket({ ...jpegHead, contentType: 'image/gif' });
		const images = encoder(new Uint8Array(10));
		const result = await processQueueMessage(event('tours/da-lat/photo.jpg', 'dinedl', { contentType: 'image/jpeg' }), deps(bucket, images));
		expect(result).toMatchObject({ outcome: 'ack', reason: 'gif' });
		expect(bucket.gets).toBe(0);
		expect(images.calls.n).toBe(0);
		expect(bucket.puts).toEqual([]);
	});

	it('acks when customMetadata.processed is already 1', async () => {
		const bucket = fakeBucket({ ...jpegHead, customMetadata: { processed: '1', sourceEtag: 'old' } });
		const images = encoder(new Uint8Array(10));
		const result = await processQueueMessage(event('tours/da-lat/photo.jpg'), deps(bucket, images));
		expect(result).toMatchObject({ outcome: 'ack', reason: 'processed' });
		expect(bucket.gets).toBe(0);
		expect(images.calls.n).toBe(0);
		expect(bucket.puts).toEqual([]);
	});

	it('acks an unknown bucket', async () => {
		const bucket = fakeBucket(jpegHead);
		const result = await processQueueMessage(event('tours/da-lat/photo.jpg', 'not-a-tenant'), deps(bucket, encoder(new Uint8Array(10))));
		expect(result).toMatchObject({ outcome: 'ack', reason: 'unknown_bucket', bucket: 'not-a-tenant' });
		expect(bucket.heads).toBe(0);
	});
});

describe('write decision', () => {
	it('does not put when the transformed output is larger than the input', async () => {
		const bucket = fakeBucket({ ...jpegHead, size: 40 });
		const images = encoder(new Uint8Array(80));
		const result = await processQueueMessage(event('blog/post/photo.jpg'), deps(bucket, images));
		expect(result).toMatchObject({ outcome: 'ack', reason: 'output_not_smaller', inputBytes: 40, outputBytes: 80 });
		expect(bucket.puts).toEqual([]);
	});

	it('overwrites the same key when the output is smaller', async () => {
		const bucket = fakeBucket({ ...jpegHead, size: 100 });
		const output = new Uint8Array(25);
		const result = await processQueueMessage(event('tours/da-lat/photo.jpg'), deps(bucket, encoder(output)));
		expect(result).toMatchObject({
			outcome: 'ack',
			reason: 'compressed',
			outputKey: 'tours/da-lat/photo.jpg',
			inputBytes: 100,
			outputBytes: 25,
		});
		expect(bucket.puts).toEqual([
			{
				key: 'tours/da-lat/photo.jpg',
				bytes: output,
				contentType: 'image/webp',
				metadata: { processed: '1', sourceEtag: 'source-etag' },
			},
		]);
	});

	it('names a sibling webp key beside the original and writes only that key', () => {
		expect(siblingObjectKey('tours/da-lat/6f0c.jpg', 'webp')).toBe('tours/da-lat/6f0c.webp');
		expect(siblingObjectKey('blog/post/id.jpeg', 'webp')).toBe('blog/post/id.webp');
		expect(siblingObjectKey('blog/post/id.png', 'webp')).toBe('blog/post/id.webp');
	});

	it('writes the sibling key and leaves the original key untouched', async () => {
		const sibling: TenantConfig = { ...DINEDL, mode: 'sibling' };
		const bucket = fakeBucket({ ...jpegHead, size: 100 });
		const output = new Uint8Array(20);
		const result = await processQueueMessage(
			event('tours/da-lat/photo.jpg'),
			deps(bucket, encoder(output), { dinedl: sibling }),
		);
		expect(result).toMatchObject({ outcome: 'ack', reason: 'compressed', outputKey: 'tours/da-lat/photo.webp' });
		expect(bucket.puts.map((put) => put.key)).toEqual(['tours/da-lat/photo.webp']);
	});
});

describe('retry policy', () => {
	it('retries transient storage failures and acks the Images quota error', async () => {
		const bucket = fakeBucket(jpegHead);
		bucket.store.head = async () => {
			throw new Error('r2 unavailable');
		};
		const failed = await processQueueMessage(event('tours/da-lat/photo.jpg'), deps(bucket, encoder(new Uint8Array(10))));
		expect(failed).toMatchObject({ outcome: 'retry', reason: 'transient_error', error: 'r2 unavailable' });

		expect(resultForError(new ImagesQuotaError('images transform failed: 9422'))).toMatchObject({
			outcome: 'ack',
			reason: 'images_quota',
		});
		expect(resultForError({ code: 9422, message: 'limit reached' })).toMatchObject({
			outcome: 'ack',
			reason: 'images_quota',
		});
	});
});
