<!-- packages/frontend/src/Mobile/VENDORED.md -->
# Vendored assets — iPod shell

The iPod Classic device chrome in this directory is adapted from
[robbiebyrd/ipod_ui](https://github.com/robbiebyrd/ipod_ui), a fork of
[mitchivin/ipod](https://github.com/mitchivin/ipod) (MIT). Vendored pieces:

- `ipodChromeMarkup.ts` — the DoodleDev-exported shell SVG blocks from
  `js/components/IpodDesign.js`, verbatim.
- `shell.css` — adapted from `css/{global,ipod,screen,menu}.css` (scoped
  under `.ipodRoot`, page background and dev chrome removed).
- `icons/*.svg` — from `public/icons/`.
- `wheelMath.ts` — rotation math ported from `js/controls.js`.

MIT license of the upstream project:

```
MIT License

Copyright (c) 2026 Mitch Ivin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
