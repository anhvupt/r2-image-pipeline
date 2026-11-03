import { TenantConfigError } from './config';
import { ImagesQuotaError, ImagesRejectedError } from './errors';
import { handleNotification, type HandleDeps, type HandleResult } from './handle';

export async function processQueueMessage(body: unknown, deps: HandleDeps): Promise<HandleResult> {
	try {
		return await handleNotification(body, deps);
	} catch (error) {
		return resultForError(error);
	}
}

export function resultForError(error: unknown): HandleResult {
	const message = error instanceof Error ? error.message : messageFrom(error);
	if (error instanceof ImagesQuotaError || imageCode(error) === 9422) {
		return { outcome: 'ack', reason: 'images_quota', error: message };
	}
	if (error instanceof ImagesRejectedError) {
		return { outcome: 'ack', reason: 'transform_rejected', error: message };
	}
	if (error instanceof TenantConfigError) {
		return { outcome: 'ack', reason: 'invalid_config', error: message };
	}
	return {
		outcome: 'retry',
		reason: 'transient_error',
		error: message,
	};
}

function imageCode(error: unknown): number | undefined {
	if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
	return typeof error.code === 'number' ? error.code : undefined;
}

function messageFrom(error: unknown): string {
	if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
		return error.message;
	}
	return String(error);
}
