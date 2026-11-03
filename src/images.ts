import { OUTPUT_MIME, type TenantConfig } from './config';
import { ImagesQuotaError, ImagesRejectedError } from './errors';
import type { ImageEncoder } from './handle';

export function createImagesEncoder(images: ImagesBinding): ImageEncoder {
	return {
		async encode(body, config) {
			return transformImage(images, body, config);
		},
	};
}

async function transformImage(
	images: ImagesBinding,
	body: ReadableStream<Uint8Array>,
	config: Pick<TenantConfig, 'maxWidth' | 'maxHeight' | 'quality' | 'format'>,
): Promise<Uint8Array> {
	const result = await images
		.input(body)
		.transform({
			width: config.maxWidth,
			height: config.maxHeight,
			fit: 'scale-down',
		})
		.output({
			format: OUTPUT_MIME[config.format],
			quality: config.quality,
		});

	const response = result.response();
	if (!response.ok) {
		const detail = await safeText(response);
		const message = `images transform failed: ${response.status} ${detail}`;
		if (response.status === 9422 || detail.includes('9422')) {
			throw new ImagesQuotaError(message);
		}
		if (response.status >= 400 && response.status < 500) {
			throw new ImagesRejectedError(message);
		}
		throw new Error(message);
	}

	return new Uint8Array(await response.arrayBuffer());
}

async function safeText(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return '';
	}
}
