/**
 * One-shot backfill stub for objects that already existed before
 * event notifications were enabled. New uploads are handled by the queue.
 *
 * This file does not list or write R2. Do not run it against a live bucket
 * until a human replaces the stub with a real one-shot implementation.
 *
 * Intended behavior:
 * 1. Read TENANT_CONFIG from wrangler.jsonc.
 * 2. For each tenant, list keys under watchPrefixes.
 * 3. head() each object. Skip processed === "1", GIF, and non-images.
 * 4. Run the same compress path as the queue consumer.
 */
console.error(
	JSON.stringify({
		event: 'r2_image_pipeline_backfill',
		outcome: 'refused',
		reason: 'stub_not_implemented',
	}),
);
process.exitCode = 1;
