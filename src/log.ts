import type { HandleResult } from './handle';

const ERROR_REASONS = new Set(['transient_error', 'invalid_config', 'images_quota', 'transform_rejected', 'missing_binding']);

/** One structured JSON line per queue message. */
export function logResult(result: HandleResult): void {
	const line = JSON.stringify({ event: 'r2_image_pipeline', ...result });
	if (result.outcome === 'retry' || ERROR_REASONS.has(result.reason)) {
		console.error(line);
	} else {
		console.log(line);
	}
}
