# SNN PDF Editor

A local PDF editor. Runs as a desktop app (Tauri) and, with fewer features, as a plain web page.

## Run

```
npm install
npm run vendor     # copies the PDF libraries into src/vendor (only after install or a version bump)
npm run dev        # start the desktop app from source
npm run build      # build snn-pdf-editor.exe and the Windows installer (src-tauri/target/release)
```

Opening `src/index.html` directly in a browser also works; there "Save" becomes a download and
new text is limited to the built-in PDF fonts.

## Layout

- `src/index.html` — the whole editor (UI, tools, export).
- `src/redact.js` — true text removal: deletes the glyphs under an edit from the page's content stream.
- `src-tauri/` — the desktop shell: file open/save by path, system fonts, "Open with".
- `test/redact.test.mjs` — `npm test`: removal checked against pdf.js on four kinds of PDF.
- `test/app.e2e.mjs` — `npm run test:app`: drives the built app (edit a line, erase a cell, save) and checks the saved file.

## How editing is saved

Replacing or erasing text adds a cover patch in the editor. On save, every glyph under a patch is
deleted from the file, so the old text can't be searched, copied or uncovered. Images and vector
drawings under a patch are covered but stay in the file.
