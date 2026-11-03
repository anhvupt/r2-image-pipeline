import { parseTenantConfig } from './config';
import { processQueueMessage } from './consume';
import type { ObjectStore } from './handle';
import { createImagesEncoder } from './images';
import { logResult } from './log';

/**
 * Queue consumer only. There is no fetch handler and no public route.
 * R2 object-create notifications arrive on the `r2-image-pipeline` queue.
 */
export default {
	async queue(batch, env): Promise<void> {
		let tenants;
		try {
			tenants = parseTenantConfig(env.TENANT_CONFIG);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			for (const queued of batch.messages) {
				logResult({ outcome: 'ack', reason: 'invalid_config', error: message });
				queued.ack();
			}
			return;
		}

		const images = createImagesEncoder(env.IMAGES);
		for (const queued of batch.messages) {
			const result = await processQueueMessage(queued.body, {
				tenants,
				images,
				bucketFor(bindingName) {
					const bucket = readBucket(env, bindingName);
					return bucket ? toStore(bucket) : undefined;
				},
			});
			logResult(result);
			if (result.outcome === 'retry') queued.retry();
			else queued.ack();
		}
	},
} satisfies ExportedHandler<Env>;

function readBucket(env: object, bindingName: string): R2Bucket | undefined {
	if (!(bindingName in env)) return undefined;
	const candidate: unknown = Reflect.get(env, bindingName);
	return isR2Bucket(candidate) ? candidate : undefined;
}

function isR2Bucket(value: unknown): value is R2Bucket {
	if (typeof value !== 'object' || value === null) return false;
	if (!('head' in value) || !('get' in value) || !('put' in value)) return false;
	return typeof value.head === 'function' && typeof value.get === 'function' && typeof value.put === 'function';
}

function toStore(bucket: R2Bucket): ObjectStore {
	return {
		async head(key) {
			const object = await bucket.head(key);
			if (!object) return null;
			return {
				size: object.size,
				etag: object.etag,
				contentType: object.httpMetadata?.contentType,
				customMetadata: object.customMetadata,
			};
		},
		async get(key) {
			const object = await bucket.get(key);
			if (!object) return null;
			return {
				size: object.size,
				etag: object.etag,
				contentType: object.httpMetadata?.contentType,
				customMetadata: object.customMetadata,
				body: object.body,
			};
		},
		async put(key, value, options) {
			await bucket.put(key, value, options);
		},
	};
}
