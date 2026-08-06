# CMS Pages — Design

**Date:** 2026-08-06
**Status:** Approved

## Summary

A Directus-authored **CMS page** system: WordPress-style static pages (not blog posts)
with WYSIWYG rich-text bodies that can carry uploaded images and third-party embeds
such as YouTube videos. Two new collections — `pages` and `page_authors` — plus an
idempotent provisioning script.

The rendering surface is **specced here but not built in this pass**: a static,
Classicy-styled page shell served at root-level slugs, with page navigation in the
top menu bar. Fixing that contract now keeps slug shape, sanitizer policy, and embed
allowlist from being re-litigated when the renderer is built.

## Decisions made

| Question | Decision |
|---|---|
| Scope this pass | Collections + provisioning script only. Renderer contract specced, not implemented. |
| Hierarchy | Self-referential `parent` M2O on `pages`, plus `sort`. Drives **navigation grouping only**, not addressing. |
| Slug shape | Flat, **globally unique**, served at **root level** (`/about`, not `/pages/about`). |
| Author | Separate `page_authors` collection (name, email, avatar) with an M2O from `pages`. `directus_users` stays unexposed. |
| Author email | **Public byline contact**, rendered as a `mailto:` link. Harvesting is an accepted cost. |
| Audit fields | `user_created` / `user_updated` kept for internal use. Their UUIDs may be publicly readable; accepted (see Permissions). |
| Embeds | `<iframe>` survives sanitization, then a post-pass strips any iframe failing a **host *and* path** allowlist. |
| WYSIWYG config | Leave interface `options` as `null` — Directus's default toolbar already has image, media, and source-code buttons. Matches `readme_articles.body`. |
| Extra fields | None. No `featured`, no hero image, no publish-date-distinct-from-created. |

## Collection: `page_authors`

A small, reusable byline record. One row per person; editing an avatar updates every
page that references it.

| Field | Type | Notes |
|---|---|---|
| `id` | integer, auto-increment PK | Matches `readme_articles` / `chat_*` convention |
| `name` | string, required | Display template for the collection |
| `email` | string, nullable | Public byline contact |
| `avatar` | M2O → `directus_files` | Uploads to the Wasabi `rt911-directus-uploads` bucket |

Everything in this collection is intended to be public. There is no field here that
needs hiding, which is what makes the license-gating question below moot.

## Collection: `pages`

Directus standard optional fields, all enabled:

- `status` — `published` / `draft` / `archived`, default `draft`
- `sort` — integer; orders siblings within a parent
- `date_created` — special `date-created`
- `date_updated` — special `date-updated`
- `user_created` — special `user-created`
- `user_updated` — special `user-updated`

Custom fields:

| Field | Type | Notes |
|---|---|---|
| `id` | integer, auto-increment PK | Matches `readme_articles` / `chat_*` convention |
| `title` | string, required | Collection display template |
| `slug` | string, required, **unique index** | Root-level route segment; reserved-slug validation below |
| `parent` | M2O → `pages`, nullable | The tree. Navigation grouping only |
| `author` | M2O → `page_authors`, nullable | |
| `body` | text, interface `input-rich-text-html`, `options: null` | Main content |
| `show_in_nav` | boolean, default `true` | A page can exist without a menu entry |

### Why slugs are globally unique rather than path-scoped

`parent` gives a real tree for the menu (**About ▸ Team**), but addressing stays flat:
`/team`, not `/about/team`.

- Lookup is one indexed query (`filter[slug][_eq]=team`) instead of resolving a path
  segment-by-segment through the parent chain from the browser.
- Directus's schema API cannot express a composite `(parent, slug)` unique constraint
  without dropping to raw SQL, so per-parent uniqueness would be unenforced anyway —
  a constraint the database doesn't hold is not a constraint.
- The cost, stated plainly: two different pages cannot both be slugged `team`.

### Deliberate omissions

No `meta_description` or OG-tag fields. The frontend is a client-rendered SPA with no
SSR or prerender step, so crawlers never see tags injected at runtime. These fields
are worth adding the day a prerender step exists, and not before.

## Permissions

Public policy (`abf8a154-5b1c-4a46-ac9c-7300570f4f17`, Directus's well-known static
Public-policy UUID) gets:

- `read` on `pages`, `fields: ["*"]`, permission filter `status = published`
- `read` on `page_authors`, `fields: ["*"]`, no filter
- `read` on `directus_files` — **verify before adding.** Avatar and inline WYSIWYG
  images are served from `/assets/<uuid>`, which does not require a `directus_files`
  row read. Only add this grant if the renderer needs file *metadata* (dimensions,
  alt text); otherwise leave it off.

### On field-level limits

Prior work in this repo records per-field permission limits as license-gated (hit on
`flight_positions`), while a later note says the license key is installed and rules
verified un-gated. This is unresolved, and **no permission grant in this repo has ever
used a narrowed `fields` list** — every existing grant is `["*"]`.

This design does not depend on the answer. Both collections are public-safe by
construction, with one exception: `user_created` / `user_updated` on `pages` will be
publicly readable as opaque UUIDs. That is accepted. Resolving a UUID to a person
requires public read on `directus_users`, which does not exist and must not be added.
The residual leak is the count of distinct editors and which pages each one touched.

## Provisioning: `packages/backend/apply-pages-schema.mjs`

Follows `apply-chat-user-fields.mjs` exactly:

- Requires `DIRECTUS_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` with **no defaults** — a
  silent `localhost` default is how you target the wrong instance by accident.
- **Dry run by default**; `--apply` to commit. Prints the plan and issues only reads
  otherwise.
- Idempotent: an existing collection is left alone; an existing field is not
  recreated; an existing permission row is compared for drift and reported, not
  silently overwritten.
- Creation order matters: `page_authors` before `pages`, because `pages.author` is an
  M2O onto it. `pages.parent` is self-referential and must be added **after** the
  `pages` collection exists.
- Logs response bodies on failure. Directus schema errors are frequently opaque 400s
  whose body is the only useful diagnostic.

Explicitly **not** `seed.mjs`. That script is a full data importer that bulk-loads
media/mp3/news/pager JSON; running it against a live database to add a collection
would be destructive.

### Operational hazards

Two prior incidents in this repo bear directly on running this script:

1. **Check `pg_stat_activity` first.** A Directus field-add `ALTER` once queued behind
   a running `pg_dump` and stalled live reads for roughly two minutes. The nightly
   backup CronJob is the thing to avoid colliding with.
2. **Don't burst.** Rapid sequences of schema operations wedge Directus's
   introspection cache, requiring an `rt911-api` pod restart to recover. The script
   should apply changes deliberately, not fire every field creation concurrently.

Seed one page (`slug: about`, `status: published`) and one author row so the renderer
is never built against an empty collection.

## Renderer contract (specced; built later)

### Routing

Root-level slugs. `/` serves the existing desktop (or the iPod shell on mobile);
`/<slug>` serves a page; an unmatched slug renders a Classicy-styled 404.

nginx already does SPA fallback (`try_files $uri $uri/ /index.html`) and resolves real
files first, so deep links work with no infrastructure change. The frontend currently
uses no client-side router and no root path other than `/` — verified across
`src/` and the Playwright e2e suite, which only ever visits `/` and `/?ipod`.

**A reserved-slug guard is required.** Because the page router becomes the catch-all,
any future root-level route would be shadowed by a page of the same slug.

Enforcement belongs on the field, not in the provisioning script — the script creates
schema, while slugs are typed by authors in the Directus UI long after it has run. So
`slug` carries a `meta.validation` filter of `{ "slug": { "_nin": [...] } }`, applied
once by the provisioning script and enforced by Directus on every save thereafter.

Initial reserved list: `assets`, `admin`, `api`. These are paths nginx or Directus
already answer, so a page slugged with one would be created successfully and then be
permanently unreachable — a silent failure worth blocking at authoring time.

### Mount point

A third branch in `src/app.tsx`, beside the existing mobile/desktop split.

This surface is **static chrome** — markup and SCSS styled to resemble Classicy — and
does **not** mount `ClassicyDesktop` or `ClassicyAppManagerProvider`. That is what
makes it safe to `lazy()`-load: the eager-import constraint documented in `app.tsx`
(lazily mounting `ClassicyDesktop` corrupts the app manager's reducer state) applies
specifically to `ClassicyDesktop`, not to arbitrary lazy children.

### Layout

- A static desktop backdrop.
- A static menu bar. Its **Pages** menu is built from the `parent` / `sort` tree,
  filtered to `show_in_nav`, with children rendered as submenus.
- One centered, non-draggable window-chrome element: title bar plus a scrollable body
  holding the rendered page.
- Byline beneath the title: author avatar, name, and `mailto:` email when present.

Navigation items are real `<a href="/team">` anchors intercepted for
`history.pushState`, so they stay right-clickable and copyable while still swapping
content without a full reload.

### Data access

Direct Directus REST, mirroring `useReadmeArticles.ts`. Requests are **strictly
sequential** — concurrent fetches against this API have been observed returning mixed
response bodies, an established constraint in this codebase.

Two queries:

1. Nav tree — `fields=id,title,slug,parent,sort`, filtered
   `status=published` and `show_in_nav=true`, `limit=-1`.
2. The page — `filter[slug][_eq]=<slug>&filter[status][_eq]=published`, with
   `fields=id,title,slug,parent,body,date_created,date_updated,author.name,author.email,author.avatar`.
   `author.avatar` resolves to the file UUID, which is all `/assets/<uuid>` needs —
   no `directus_files` row read is involved.

### Sanitizer: `src/lib/renderPageHtml.ts`

A standalone module, not folded into an existing app, so `README` and `Browser` can
adopt it later without being forced to now.

```
DOMPurify.sanitize(html, {
  ADD_TAGS: ["iframe"],
  ADD_ATTR: ["allow", "allowfullscreen", "frameborder",
             "width", "height", "title", "loading", "referrerpolicy"],
})
  → post-pass: remove every <iframe> whose src fails the host AND path check
```

`ADD_ATTR` is limited to the attributes a video embed actually needs. Notably absent:
`srcdoc`, which would let an iframe carry its own inline document and bypass the src
allowlist entirely.

Allowlist:

| Host | Required path prefix |
|---|---|
| `www.youtube-nocookie.com` | `/embed/` |
| `www.youtube.com` | `/embed/` |
| `player.vimeo.com` | `/video/` |
| `archive.org` | `/embed/` |

The path check is not decoration. Allowing `www.youtube.com` by host alone would admit
arbitrary YouTube pages framed inside the site. `src` values are parsed with `URL`
and rejected on any parse failure, so protocol-relative and `javascript:` sources
cannot slip through as unparsed strings.

The threat model is a compromised or careless author account, not an anonymous
attacker — only Directus users can write `body`. The allowlist converts "an author can
inject an arbitrary iframe" into "an author can embed a video."

## Testing

Co-located per repo convention. Frontend vitest has **no RTL auto-cleanup**, so any
new component test file needs its own `afterEach(cleanup)`.

Sanitizer tests carry the security weight and get mutation checks — each assertion
must fail if the allowlist is loosened:

- A legitimate `youtube-nocookie.com/embed/<id>` iframe survives.
- An iframe at `evil.com` is stripped.
- `youtube.com/watch?v=<id>` is stripped — proves the check is path-scoped, not
  host-only.
- `javascript:` and unparseable `src` values are stripped.
- An iframe carrying `srcdoc` is stripped. DOMPurify's default attribute allowlist
  should already exclude it, but the post-pass removes any iframe bearing `srcdoc`
  unconditionally — an assertion here catches a future DOMPurify default change that
  would otherwise silently reopen the bypass.
- `<script>` is stripped (baseline DOMPurify behavior, asserted so a future
  configuration change cannot silently disable it).

Nav-tree builder tests:

- Children nest under parents and sort ascending within a parent.
- A page whose `parent` points at a missing or unpublished row is treated as a root
  rather than dropped.
- **Cycle safety** — an author can set A→B→A through the Directus picker; the builder
  must terminate rather than hang the tab.

## Out of scope

- SSR, prerendering, and SEO meta tags.
- Page versioning, revision history, and draft preview links.
- Localization / translations.
- Retrofitting `README` or `Browser` onto the shared sanitizer.
- Any streamer or virtual-clock involvement. Pages are present-day content and are
  **not** time-gated.

## Open risks

- **Root-level slugs make the page router the catch-all.** Any future root route needs
  adding to the reserved list, or a page slug will shadow it. Low likelihood, cheap to
  fix, but it is a one-way door on URL shape.
- **The publicly readable author email will be scraped.** Accepted explicitly.
- **Field-limit enforcement remains unverified.** This design routes around it rather
  than resolving it; if a future collection genuinely needs a hidden field, that
  question has to be settled first with a live probe.
