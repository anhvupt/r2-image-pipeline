import {
	OUTPUT_MIME,
	bindingNameFor,
	contentTypeSkipReason,
	lookupTenant,
	matchesPrefix,
	matchesSuffix,
	siblingObjectKey,
	type TenantConfig,
	type TenantConfigMap,
} from './config';

const CREATE_ACTIONS = new Set(['PutObject', 'CopyObject', 'CompleteMultipartUpload']);

export interface ObjectHead {
	size: number;
	etag: string;
	contentType?: string;
	customMetadata?: Record<string, string>;
}

export interface StoredObject extends ObjectHead {
	body: ReadableStream<Uint8Array>;
}

export interface ObjectStore {
	head(key: string): Promise<ObjectHead | null>;
	get(key: string): Promise<StoredObject | null>;
	put(
		key: string,
		value: Uint8Array,
		options: {
			httpMetadata: { contentType: string };
			customMetadata: { processed: '1'; sourceEtag: string };
		},
	): Promise<void>;
}

export interface ImageEncoder {
	encode(body: ReadableStream<Uint8Array>, config: Pick<TenantConfig, 'maxWidth' | 'maxHeight' | 'quality' | 'format'>): Promise<Uint8Array>;
}

export interface HandleDeps {
	tenants: TenantConfigMap;
	bucketFor(bindingName: string): ObjectStore | undefined;
	images: ImageEncoder;
}

export interface HandleResult {
	outcome: 'ack' | 'retry';
	reason: string;
	bucket?: string;
	key?: string;
	tenant?: string;
	outputKey?: string;
	inputBytes?: number;
	outputBytes?: number;
	error?: string;
}

export async function handleNotification(body: unknown, deps: HandleDeps): Promise<HandleResult> {
	const event = parseEvent(body);
	if (!event) {
		return { outcome: 'ack', reason: 'invalid_message' };
	}

	const { bucket, key } = event;
	if (event.action && !CREATE_ACTIONS.has(event.action)) {
		return { outcome: 'ack', reason: 'ignored_action', bucket, key };
	}

	const config = lookupTenant(deps.tenants, bucket);
	if (!config) {
		return { outcome: 'ack', reason: 'unknown_bucket', bucket, key };
	}

	const base = { bucket, key, tenant: config.tenant };
	if (!matchesPrefix(key, config.watchPrefixes)) {
		return { ...base, outcome: 'ack', reason: 'prefix' };
	}
	if (!matchesSuffix(key, config.watchSuffixes)) {
		return { ...base, outcome: 'ack', reason: 'suffix' };
	}

	const store = deps.bucketFor(bindingNameFor(bucket, config));
	if (!store) {
		return { ...base, outcome: 'ack', reason: 'missing_binding' };
	}

	const head = await store.head(key);
	if (!head) {
		return { ...base, outcome: 'ack', reason: 'missing_object' };
	}

	const contentSkip = contentTypeSkipReason(head.contentType);
	if (contentSkip) {
		return { ...base, outcome: 'ack', reason: contentSkip };
	}

	if (config.skipIfProcessedMeta && head.customMetadata?.processed === '1') {
		return { ...base, outcome: 'ack', reason: 'processed' };
	}

	const object = await store.get(key);
	if (!object) {
		return { ...base, outcome: 'ack', reason: 'missing_object' };
	}

	const output = await deps.images.encode(object.body, config);
	const inputBytes = head.size;
	const outputBytes = output.byteLength;
	if (outputBytes >= inputBytes) {
		return { ...base, outcome: 'ack', reason: 'output_not_smaller', inputBytes, outputBytes };
	}

	const outputKey = config.mode === 'sibling' ? siblingObjectKey(key, config.format) : key;
	if (outputKey === key && config.mode === 'sibling') {
		return { ...base, outcome: 'ack', reason: 'sibling_same_key', inputBytes, outputBytes, outputKey };
	}

	await store.put(outputKey, output, {
		httpMetadata: { contentType: OUTPUT_MIME[config.format] },
		customMetadata: { processed: '1', sourceEtag: head.etag },
	});

	return { ...base, outcome: 'ack', reason: 'compressed', inputBytes, outputBytes, outputKey };
}

interface R2CreateEvent {
	bucket: string;
	key: string;
	action?: string;
}

function parseEvent(body: unknown): R2CreateEvent | null {
	if (!isRecord(body)) return null;
	if (typeof body.bucket !== 'string' || body.bucket.length === 0) return null;
	if (!isRecord(body.object)) return null;
	if (typeof body.object.key !== 'string' || body.object.key.length === 0) return null;
	const action = typeof body.action === 'string' ? body.action : undefined;
	return { bucket: body.bucket, key: body.object.key, action };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
