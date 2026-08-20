# rt911-api: stock Directus pinned to an exact version, plus our extensions.
# The extension "build" is a straight copy (plain CJS, no transform), so the
# image copies src/ directly into the extension's dist path.
FROM directus/directus:12.1.1

COPY profile-api/package.json /directus/extensions/directus-extension-profile-api/package.json
COPY profile-api/src/index.js /directus/extensions/directus-extension-profile-api/dist/index.js
