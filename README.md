# r2-image-pipeline

Shared Cloudflare Worker. On R2 object-create, compress an image (resize + WebP) and write it back. One Worker, tenant config keyed by bucket name. First tenant: Dinedl.

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

Dinedl settings, keyed by the notification bucket name `dinedl`:

```json
{
  "dinedl": {
    "tenant": "dinedl",
    "maxWidth": 1920,
    "maxHeight": 1920,
    "quality": 80,
    "format": "webp",
    "mode": "overwrite",
    "watchPrefixes": ["tours/", "blog/"],
    "watchSuffixes": [".jpg", ".jpeg", ".png", ".webp"],
    "skipIfProcessedMeta": true
  }
}
```

`format`, `quality`, and `mode` are per tenant. Resize is `maxWidth` x `maxHeight` with `fit: "scale-down"`. Dinedl uses WebP quality 80. There is no max-bytes skip.

Watched keys are `tours/{slug}/{uuid}.jpg` and `blog/{slug}/{uuid}.jpg`, plus `.jpeg`, `.png`, and `.webp`. GIF is not transformed. Do not add a `.gif` notification rule. The Worker also skips a watched key when `head()` reports `image/gif`, and it skips non-images.

Unknown bucket names are logged and acked. A configured tenant whose R2 binding is missing is acked with reason `missing_binding`. Successes and permanent skips are acked. Transient R2 or Images failures are retried up to 3 times, then the message is discarded. The original object is left as uploaded. One JSON log line is written per message (`event` is `r2_image_pipeline`).

`TENANT_CONFIG` is a JSON object var in `wrangler.jsonc`. Wrangler vars accept JSON values, and this config is small, so it does not need KV.

The R2 binding name matches the bucket name (`dinedl`). Adding a tenant does not fork the handler. If a future bucket name is not a valid JavaScript identifier, set `binding` on that config row and use the same name in `r2_buckets`.

## Wire up Dinedl

Log in as a member of the account that owns bucket `dinedl`:

```bash
npx wrangler login
```

Create the queue:

```bash
npx wrangler queues create r2-image-pipeline
```

Notification rules for new objects. A key cannot end in more than one of these suffixes, so the rules do not overlap. Prefix filtering happens in the Worker: a `.jpg` outside `tours/` and `blog/` is acked and skipped.

```bash
npx wrangler r2 bucket notification create dinedl --event-type object-create --queue r2-image-pipeline --suffix jpg
npx wrangler r2 bucket notification create dinedl --event-type object-create --queue r2-image-pipeline --suffix jpeg
npx wrangler r2 bucket notification create dinedl --event-type object-create --queue r2-image-pipeline --suffix png
npx wrangler r2 bucket notification create dinedl --event-type object-create --queue r2-image-pipeline --suffix webp
```

Deploy the consumer:

```bash
npx wrangler deploy
```

Only new uploads are processed. Objects already in the bucket do not emit object-create. `scripts/backfill.mjs` is a one-shot stub and refuses to run. Do not point it at the live bucket until it is implemented.

```bash
node scripts/backfill.mjs
```

## Why suffix rules do not stop the loop

Overwrite writes the compressed bytes back to the same key, for example `tours/{slug}/{uuid}.jpg`. That key still ends in `jpg`, so the `jpg` notification fires again. Suffix rules look at the key. They do not look at content type or custom metadata.

The loop stops on metadata. Before transforming, the Worker calls `head()`. If `customMetadata.processed === "1"`, it acks and returns. The overwrite `put` sets `processed` to `"1"` and `sourceEtag` to the etag that was compressed. The second delivery sees that metadata and does not transform again.

Sibling mode does not avoid a second notification either. The new key ends in `.webp`, which matches the `webp` rule. That object is written with `processed: "1"`, so the follow-up message is acked. The original key is not rewritten, so it does not notify a second time.

## Smoke test

Run this after the queue, the four notification rules, and the deploy exist.

1. Upload one new tour image through the Dinedl presigned PUT, at a key like `tours/{slug}/{uuid}.jpg`. Use a new key. An object that was already in the bucket will not notify.
2. Tail the Worker:

```bash
npx wrangler tail
```

3. Expect one log line with `reason` `compressed` and `outputKey` equal to the uploaded key, then a second delivery with `reason` `processed`.
4. Confirm the object key is unchanged, `content-type` is `image/webp`, and custom metadata contains `processed=1`. The public URL remains `NEXT_PUBLIC_IMAGE_BASE` plus that key.
5. If the compressed bytes are not smaller than the upload, the log reason is `output_not_smaller` and the original object is unchanged.

## Add TOVN

TOVN uses this same Worker. No code fork. A Worker cannot bind an R2 bucket in another Cloudflare account, so TOVN joins only when its bucket is in the account that owns `dinedl`.

No R2 bucket name or key layout was found for TOVN. Leave the bucket name and key prefix as placeholders until they are known. Do not invent them.

1. Add a `TENANT_CONFIG` row whose key is the real bucket name. Default `mode` to `overwrite` so object URLs stay stable. Set `mode` to `sibling` only if that tenant must keep the original bytes beside a new key (`foo.jpg` stays, `foo.webp` is added).

```json
"REPLACE_WITH_TOVN_BUCKET_NAME": {
  "tenant": "tovn",
  "maxWidth": 1920,
  "maxHeight": 1920,
  "quality": 80,
  "format": "webp",
  "mode": "overwrite",
  "watchPrefixes": ["REPLACE_WITH_TOVN_PREFIX/"],
  "watchSuffixes": [".jpg", ".jpeg", ".png", ".webp"],
  "skipIfProcessedMeta": true
}
```

2. Add an R2 binding with that same bucket name. `binding` must be a valid JavaScript identifier. If the real bucket name contains a hyphen, choose an identifier, set `"binding"` on the config row, and use that identifier in `r2_buckets`.

```json
{
  "binding": "REPLACE_WITH_TOVN_BUCKET_NAME",
  "bucket_name": "REPLACE_WITH_TOVN_BUCKET_NAME"
}
```

3. Create notification rules for the real bucket. Replace the bucket name. Do not add a gif rule. Add a suffix only when that tenant's keys use it.

```bash
npx wrangler r2 bucket notification create REPLACE_WITH_TOVN_BUCKET_NAME --event-type object-create --queue r2-image-pipeline --suffix jpg
npx wrangler r2 bucket notification create REPLACE_WITH_TOVN_BUCKET_NAME --event-type object-create --queue r2-image-pipeline --suffix jpeg
npx wrangler r2 bucket notification create REPLACE_WITH_TOVN_BUCKET_NAME --event-type object-create --queue r2-image-pipeline --suffix png
npx wrangler r2 bucket notification create REPLACE_WITH_TOVN_BUCKET_NAME --event-type object-create --queue r2-image-pipeline --suffix webp
```

4. Deploy again with `npx wrangler deploy`.

Commented placeholders for this row and binding are in `wrangler.jsonc`.

## Add Haibontui

Haibontui is a later tenant. Treat it the same way as TOVN: one config row, one R2 binding, and notification rules on the real bucket. Same code path. Default the example to `mode` `overwrite`. Use `sibling` only if the original bytes must stay beside a new key. No bucket name is known, so the placeholder stays `REPLACE_WITH_HAIBONTUI_BUCKET_NAME`. The bucket must be in the same Cloudflare account as `dinedl`.

## Develop

```bash
npm install
npm test
npm run cf-typegen
npm run typecheck
npx wrangler deploy --dry-run
```

`npm test` runs unit tests in Node. It does not call Cloudflare. `.dev.vars.example` documents that this Worker has no secrets. Do not commit `.dev.vars` or `.env`.
