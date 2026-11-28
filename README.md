# PaintBoard

PaintBoard is a browser whiteboard for teaching, sketching, and editing images. It supports mouse, touch, and pen input and saves boards in the current browser.

## Features

- Draw with pencil, brushes, shapes, text, fill, and eraser. Select, crop, rotate, flip, and resize artwork.
- Insert a table from the toolbar, drag to place it, then type directly into cells. Press Tab to move to the next cell. Use the Text tool to edit a placed table.
- Turn on ruled lines, a grid, or rulers in View. Use the laser pointer (V) to highlight a spot while teaching. The guides and pointer are screen-only.
- Keep multiple boards, undo and redo edits, and export or print your work. Image export supports PNG, JPEG, BMP, GIF, TIFF, and WebP where the browser can encode it.

## Run locally

Use Node.js 24 or newer.

```sh
npm ci
npm run dev
```

Open [PaintBoard on localhost](http://localhost:3000/).

## Build and host

```sh
npm run lint
npm run build
npm run preview
```

Deploy the contents of `dist/` to a static HTTPS host. The build uses relative asset paths, so it can be served under a subdirectory. PaintBoard runs entirely in the browser and uses no server, account, or API key.

## Save and back up boards

Autosave is tied to the browser profile and site address. Use **File → Save project** to download a JSON backup before clearing site data, moving to a different browser, or changing the hosting address. Use **File → Import Project** to restore it. Import replaces the current workspace, so save your current boards first if you want to keep them.

## Credits

Uicons by [Flaticon](https://www.flaticon.com/uicons).
