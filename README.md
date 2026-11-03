# r2-image-pipeline

Shared Cloudflare Worker. On R2 object-create, compress an image (resize + WebP) and write it back. One Worker, tenant config keyed by bucket name.

The public URL for a Dinedl image is `NEXT_PUBLIC_IMAGE_BASE` plus the object key. Overwrite mode keeps that key, including the original extension such as `.jpg`, and sets the object content type to `image/webp`.

## Deploy target

- Worker name: `r2-image-pipeline`
- Cloudflare account: the account that owns the Dinedl R2 bucket `dinedl`
- Queue consumer only. No public route. `workers_dev` and preview URLs are off, and the Worker has no `route` or `routes`.
- Do not set `account_id` in `wrangler.jsonc`. `wrangler login` selects the account.

A Worker cannot bind an R2 bucket in another Cloudflare account. TOVN and Haibontui join this Worker only when their buckets are in the same account as `dinedl`.

Requires Node.js 22 or newer.

## Flow

```text
R2 object-create → queue r2-image-pipeline → this Worker
  → tenant config by message bucket name
  → prefix and suffix checks
  → head() for content type and custom metadata
  → Images binding resize + encode (bytes stay on R2)
  → put the same key, or a sibling key, only when the output is smaller
```

Content type is not on the queue message. The Worker calls `head()` first and calls `get()` only when it is going to transform. The Images binding (`env.IMAGES`) resizes and encodes. This project does not use Cloudflare Images hosted storage.

Images Free includes 5,000 unique transformations per calendar month. Each pair of source image and transform parameters counts once in that month. `format` and `quality` do not create a separate transformation. Past the limit, new transforms fail with error `9422` and this Worker acks the message so the original object stays in place. `.info()` calls are not used and are not billed.

## Develop

```bash
npm install
npm test
npm run cf-typegen
npm run typecheck
npx wrangler deploy --dry-run
```

`npm test` runs unit tests in Node. It does not call Cloudflare. `.dev.vars.example` documents that this Worker has no secrets. Do not commit `.dev.vars` or `.env`.
