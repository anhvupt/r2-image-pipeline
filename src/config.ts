export const OUTPUT_FORMATS = ['webp', 'jpeg', 'png', 'avif'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const OUTPUT_MIME: Record<OutputFormat, 'image/webp' | 'image/jpeg' | 'image/png' | 'image/avif'> = {
	webp: 'image/webp',
	jpeg: 'image/jpeg',
	png: 'image/png',
	avif: 'image/avif',
};

export type WriteMode = 'overwrite' | 'sibling';

export interface TenantConfig {
	tenant: string;
	maxWidth: number;
	maxHeight: number;
	quality: number;
	format: OutputFormat;
	mode: WriteMode;
	watchPrefixes: string[];
	watchSuffixes: string[];
	skipIfProcessedMeta: boolean;
	/**
	 * R2 binding name when it cannot match the bucket name.
	 * Bucket names with hyphens are not valid JavaScript identifiers.
	 * Defaults to the config key, which is the notification bucket name.
	 */
	binding?: string;
}

export type TenantConfigMap = Record<string, TenantConfig>;

export class TenantConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TenantConfigError';
	}
}

const WRITE_MODES = ['overwrite', 'sibling'] as const;
const RASTER_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

export function parseTenantConfig(input: unknown): TenantConfigMap {
	const value = typeof input === 'string' ? parseJsonString(input) : input;
	if (!isRecord(value)) {
		throw new TenantConfigError('TENANT_CONFIG must be an object keyed by bucket name');
	}

	const map: TenantConfigMap = {};
	for (const [bucket, raw] of Object.entries(value)) {
		if (bucket.length === 0) {
			throw new TenantConfigError('TENANT_CONFIG bucket name must not be empty');
		}
		map[bucket] = validateTenant(bucket, raw);
	}
	return map;
}

export function lookupTenant(map: TenantConfigMap, bucket: string): TenantConfig | undefined {
	return Object.hasOwn(map, bucket) ? map[bucket] : undefined;
}

export function bindingNameFor(bucket: string, config: TenantConfig): string {
	return config.binding && config.binding.length > 0 ? config.binding : bucket;
}

/** `tours/slug/id.jpg` + webp → `tours/slug/id.webp`. */
export function siblingObjectKey(key: string, format: OutputFormat): string {
	const slash = key.lastIndexOf('/');
	const dir = slash === -1 ? '' : key.slice(0, slash + 1);
	const file = slash === -1 ? key : key.slice(slash + 1);
	const dot = file.lastIndexOf('.');
	const stem = dot > 0 ? file.slice(0, dot) : file;
	return `${dir}${stem}.${format}`;
}

export function matchesPrefix(key: string, prefixes: readonly string[]): boolean {
	return prefixes.some((prefix) => key.startsWith(prefix));
}

export function matchesSuffix(key: string, suffixes: readonly string[]): boolean {
	return suffixes.some((suffix) => key.endsWith(suffix));
}

/**
 * Content type comes from R2 head(), not the queue message.
 * GIF is never transformed. Other non-raster types are skipped.
 */
export function contentTypeSkipReason(contentType: string | undefined): 'missing_content_type' | 'gif' | 'non_image' | null {
	if (!contentType) return 'missing_content_type';
	const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
	if (mime === 'image/gif') return 'gif';
	if (!RASTER_TYPES.has(mime)) return 'non_image';
	return null;
}

function parseJsonString(input: string): unknown {
	try {
		return JSON.parse(input);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new TenantConfigError(`TENANT_CONFIG is not valid JSON: ${message}`);
	}
}

function validateTenant(bucket: string, raw: unknown): TenantConfig {
	if (!isRecord(raw)) {
		throw new TenantConfigError(`tenant "${bucket}" must be an object`);
	}

	const binding = optionalString(raw, 'binding', bucket);
	const config: TenantConfig = {
		tenant: requiredString(raw, 'tenant', bucket),
		maxWidth: requiredPositiveInt(raw, 'maxWidth', bucket),
		maxHeight: requiredPositiveInt(raw, 'maxHeight', bucket),
		quality: requiredQuality(raw, bucket),
		format: requiredEnum(raw, 'format', OUTPUT_FORMATS, bucket),
		mode: requiredEnum(raw, 'mode', WRITE_MODES, bucket),
		watchPrefixes: requiredStringArray(raw, 'watchPrefixes', bucket),
		watchSuffixes: requiredStringArray(raw, 'watchSuffixes', bucket),
		skipIfProcessedMeta: requiredBoolean(raw, 'skipIfProcessedMeta', bucket),
	};
	if (binding) config.binding = binding;
	return config;
}

function requiredString(raw: Record<string, unknown>, field: string, bucket: string): string {
	const value = raw[field];
	if (typeof value !== 'string' || value.length === 0) {
		throw new TenantConfigError(`tenant "${bucket}" field ${field} must be a non-empty string`);
	}
	return value;
}

function optionalString(raw: Record<string, unknown>, field: string, bucket: string): string | undefined {
	if (!Object.hasOwn(raw, field) || raw[field] === undefined) return undefined;
	return requiredString(raw, field, bucket);
}

function requiredPositiveInt(raw: Record<string, unknown>, field: string, bucket: string): number {
	const value = raw[field];
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
		throw new TenantConfigError(`tenant "${bucket}" field ${field} must be a positive integer`);
	}
	return value;
}

function requiredQuality(raw: Record<string, unknown>, bucket: string): number {
	const value = raw.quality;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) {
		throw new TenantConfigError(`tenant "${bucket}" field quality must be an integer from 1 to 100`);
	}
	return value;
}

function requiredBoolean(raw: Record<string, unknown>, field: string, bucket: string): boolean {
	const value = raw[field];
	if (typeof value !== 'boolean') {
		throw new TenantConfigError(`tenant "${bucket}" field ${field} must be a boolean`);
	}
	return value;
}

function requiredStringArray(raw: Record<string, unknown>, field: string, bucket: string): string[] {
	const value = raw[field];
	if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.length === 0)) {
		throw new TenantConfigError(`tenant "${bucket}" field ${field} must be a non-empty array of non-empty strings`);
	}
	return value;
}

function requiredEnum<T extends string>(raw: Record<string, unknown>, field: string, allowed: readonly T[], bucket: string): T {
	const value = raw[field];
	if (typeof value !== 'string' || !allowed.includes(value as T)) {
		throw new TenantConfigError(`tenant "${bucket}" field ${field} must be one of ${allowed.join(', ')}`);
	}
	return value as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
