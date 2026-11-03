export class ImagesQuotaError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ImagesQuotaError';
	}
}

export class ImagesRejectedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ImagesRejectedError';
	}
}
