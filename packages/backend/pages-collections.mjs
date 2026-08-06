/**
 * pages-collections.mjs
 *
 * Schema definitions for the two CMS page collections (see
 * plans/2026-08-06-cms-pages-design.md). Pure data — no I/O, no side
 * effects — so this module can be imported by anything without
 * consequence. apply-pages-schema.mjs is the only consumer today.
 *
 * Deliberately NOT added to seed.mjs. That script bulk-imports historical
 * media/news/pager fixtures on import; these collections are authored
 * content and have no fixture data to load.
 */

// Entries in the frontend docroot (packages/frontend/nginx.conf) that nginx's
// `try_files $uri $uri/ /index.html` resolves BEFORE the SPA fallback. A page
// slugged with one of these would be created successfully and then be
// permanently unreachable, so Directus rejects them at save time via the
// `slug` field's validation filter below. Verified directly against the
// production docroot: 50x.html, assets, img, index.html, maps, stacks.
// `50x.html` and `index.html` are files, not usable slug shapes, so they are
// omitted here. This list must be revisited if the docroot gains directories.
export const RESERVED_SLUGS = ["assets", "img", "maps", "stacks"];

const STATUS_CHOICES = ["published", "draft", "archived"].map((v) => ({ text: v, value: v }));

export const PAGE_COLLECTIONS = [
  {
    collection: "page_authors",
    meta: {
      icon: "person",
      note: "Public byline records for CMS pages. Everything here is intended to be publicly readable.",
      display_template: "{{name}}",
    },
    schema: {},
    fields: [
      { field: "id", type: "integer", schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true } },
      { field: "name", type: "string", schema: { is_nullable: false },
        meta: { interface: "input", width: "half", required: true } },
      { field: "email", type: "string", schema: { is_nullable: true },
        meta: { interface: "input", width: "half", note: "Rendered publicly as a mailto link. Expect it to be scraped." } },
      { field: "avatar", type: "uuid", schema: { is_nullable: true },
        meta: { interface: "file-image", special: ["file"], width: "half" } },
    ],
  },
  {
    collection: "pages",
    meta: {
      icon: "description",
      sort_field: "sort",
      note: "CMS pages (not blog posts). `parent` groups the nav menu; slugs stay flat and globally unique.",
      display_template: "{{title}}",
      archive_field: "status",
      archive_value: "archived",
      unarchive_value: "draft",
    },
    schema: {},
    fields: [
      { field: "id", type: "integer", schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true } },
      { field: "status", type: "string", schema: { is_nullable: false, default_value: "draft" },
        meta: { interface: "select-dropdown", width: "half", options: { choices: STATUS_CHOICES } } },
      { field: "title", type: "string", schema: { is_nullable: false },
        meta: { interface: "input", width: "half", required: true } },
      // is_unique gives the DB-level guarantee; the validation filter is a
      // separate concern (reserved words, not collisions).
      { field: "slug", type: "string", schema: { is_nullable: false, is_unique: true },
        meta: {
          interface: "input", width: "half", required: true,
          options: { slug: true, trim: true },
          validation: { slug: { _nin: RESERVED_SLUGS } },
          validation_message: `Reserved path — pick another slug. Reserved: ${RESERVED_SLUGS.join(", ")}`,
          note: "Served at the site root, e.g. slug `about` → /about",
        } },
      { field: "parent", type: "integer", schema: { is_nullable: true },
        meta: { interface: "select-dropdown-m2o", width: "half", options: { template: "{{title}}" },
                note: "Groups this page under another in the nav menu. Does NOT affect the URL." } },
      { field: "author", type: "integer", schema: { is_nullable: true },
        meta: { interface: "select-dropdown-m2o", width: "half", options: { template: "{{name}}" } } },
      // options intentionally omitted -> Directus's default WYSIWYG toolbar,
      // which already carries the image, media (iframe embed), and source-code
      // buttons. Matches readme_articles.body, whose options are null.
      { field: "body", type: "text", schema: { is_nullable: true },
        meta: { interface: "input-rich-text-html", width: "full" } },
      { field: "show_in_nav", type: "boolean", schema: { is_nullable: false, default_value: true },
        meta: { interface: "boolean", width: "half", note: "Unchecked pages still resolve by URL, they just leave the menu." } },
      { field: "sort", type: "integer", schema: { is_nullable: true }, meta: { hidden: true } },
      { field: "date_created", type: "timestamp", schema: { is_nullable: true },
        meta: { special: ["date-created"], interface: "datetime", readonly: true, hidden: true, width: "half" } },
      { field: "date_updated", type: "timestamp", schema: { is_nullable: true },
        meta: { special: ["date-updated"], interface: "datetime", readonly: true, hidden: true, width: "half" } },
      { field: "user_created", type: "uuid", schema: { is_nullable: true },
        meta: { special: ["user-created"], interface: "select-dropdown-m2o", readonly: true, hidden: true, width: "half" } },
      { field: "user_updated", type: "uuid", schema: { is_nullable: true },
        meta: { special: ["user-updated"], interface: "select-dropdown-m2o", readonly: true, hidden: true, width: "half" } },
    ],
  },
];

// Directus does NOT infer relations from field naming — without these rows,
// `parent`/`author` render as bare number inputs and REST field expansion
// (`fields=author.name`) silently returns nothing.
export const PAGES_RELATIONS = [
  { collection: "pages", field: "parent", related_collection: "pages",
    meta: { sort_field: null }, schema: { on_delete: "SET NULL" } },
  { collection: "pages", field: "author", related_collection: "page_authors",
    meta: { sort_field: null }, schema: { on_delete: "SET NULL" } },
  { collection: "page_authors", field: "avatar", related_collection: "directus_files",
    meta: { sort_field: null }, schema: { on_delete: "SET NULL" } },
  { collection: "pages", field: "user_created", related_collection: "directus_users",
    meta: { sort_field: null }, schema: { on_delete: "SET NULL" } },
  { collection: "pages", field: "user_updated", related_collection: "directus_users",
    meta: { sort_field: null }, schema: { on_delete: "SET NULL" } },
];

// Field-level limits ARE enforced on this instance — three public grants
// (news_items, sources, tv_channels) already use narrowed lists. Listing
// fields explicitly keeps the user_created/user_updated audit UUIDs out of
// public reads. Any field added to `pages` must be added here too, or it
// will be invisible to the frontend.
const PAGES_PUBLIC_FIELDS = [
  "id", "status", "title", "slug", "parent", "author",
  "body", "show_in_nav", "sort", "date_created", "date_updated",
];

export const PAGES_PERMISSIONS = [
  { collection: "pages", action: "read", fields: PAGES_PUBLIC_FIELDS, permissions: { status: { _eq: "published" } } },
  { collection: "page_authors", action: "read", fields: ["*"], permissions: {} },
];

/**
 * Directus folder that page images and author avatars are uploaded into.
 *
 * This exists because `/assets/<uuid>` is NOT public by default: it enforces
 * read permission on the directus_files ROW, so without a grant every inline
 * image and every avatar 403s for anonymous visitors. Verified against the live
 * instance — an uploaded image returned 403 until this grant existed.
 *
 * A blanket grant on directus_files is not acceptable: the same table holds the
 * per-user Classicy filesystem snapshots written by the filesystem-sync
 * feature, and `/assets/<uuid>` would serve those private JSON documents to
 * anyone. Scoping the grant to one folder is what keeps CMS imagery public
 * while leaving everything else unreadable.
 */
export const PAGES_ASSET_FOLDER = "CMS Pages";

/**
 * Public read on directus_files, confined to the CMS asset folder.
 *
 * Takes the folder id because Directus generates it at creation time, so it
 * cannot be a static constant here. Fields are narrowed to what a renderer
 * could legitimately want (dimensions, alt text) — filename_download and
 * uploaded_by are deliberately absent.
 */
export function pagesFilesPermission(folderId) {
  return {
    collection: "directus_files",
    action: "read",
    fields: ["id", "title", "description", "type", "width", "height", "filesize", "folder"],
    permissions: { folder: { _eq: folderId } },
  };
}
