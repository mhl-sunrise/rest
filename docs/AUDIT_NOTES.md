# REST Client Static PWA Audit Notes

This package is a hardened refactor of the original static PWA REST client. It preserves the static-hosting deployment model and the original dark GitHub-style visual language while separating markup, styling, application logic, PWA metadata, service-worker behavior, icons, and documentation into reviewable locations.

## Summary of Improvements

| Area | Original Risk or Limitation | Improvement Implemented |
|---|---|---|
| Application structure | A compact single-file implementation mixed markup, CSS, JavaScript, PWA registration, and application logic. | Reorganized the project into a professional static-app structure with root deployment files, `assets/css/styles.css`, `assets/js/app.js`, `assets/icons/`, and `docs/AUDIT_NOTES.md`. |
| XSS posture | User-controlled key/value inputs were interpolated into dynamic HTML. | Replaced dynamic HTML injection with DOM node construction and `textContent`; source review confirms no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, dynamic-code execution, or inline event handlers were introduced. |
| Content Security Policy | Inline scripts and styles prevented a strong CSP. | Added a strict CSP in `index.html` with external script/style assets, `base-uri 'none'`, `object-src 'none'`, and `form-action 'none'`. `connect-src *` is intentionally retained because this is a browser REST client whose core function is user-directed requests to arbitrary endpoints. |
| Secrets handling | Bearer tokens, basic credentials, and API-key values could be serialized into local storage. | Authentication secrets are retained in memory only for the current page session. Persisted tab state keeps non-secret request metadata, URL, params, headers, body, and response history. Generated PHP cURL output redacts secret values. |
| Service worker privacy | The previous worker behavior was not explicit about API privacy boundaries. | The service worker uses a fixed app-shell allowlist and explicitly avoids intercepting or caching cross-origin API traffic. The app-shell cache namespace was refreshed to `restclient-shell-v13` for the v18 dropdown cleanup so returning PWA users receive the updated stylesheet rather than a cached v17 shell. |
| Request robustness | Requests had limited validation and no request cancellation semantics. | Added URL validation, `AbortController` handling for superseded requests, `cache: 'no-store'`, safer `Headers` construction, JSON content-type detection, and improved CORS error messaging. |
| Focus styling preference | Earlier iterations included focus outlines and focus box-shadows for accessibility affordance. | Per user preference, all focus outlines and focus box-shadows are disabled globally and verified by browser-computed style checks on focused controls. |
| PWA install UX | The compact install button needed stronger control over sizing and surface styling. | The `.pwa-install` control is exactly `45px` by `45px`, uses a solid borderless blue surface, and keeps the `20px` white filled inline SVG download icon. |
| Generated PHP quality | Output formatting needed to match the original simple cURL structure expected by the user. | PHP cURL generation uses a compact `curl_setopt_array` structure, avoids trailing commas inside header arrays, redacts secrets, and leaves punctuation unhighlighted so the code is easier to copy and audit. |
| Tab, form, and response UX | Tab growth, parameter/header row sizing, response output discovery, copy handling, and Body/Auth form alignment needed stronger product polish. | Enforced an eight-tab maximum, removed excess horizontal padding from the request/output tabs, made all Params, Headers, Auth, and Body input/dropdown controls use a consistent `height: 40px` and `padding: 0 12px`, matched dropdown borders and backgrounds to the surrounding dark input treatment, removed the unintended blue closed-select treatment, added explicit dark color-scheme and dark option styling for the native menu surface where browser support permits it, nudged the remove-row `×` glyph slightly upward while preserving its 40px square button, removed the visible `Type` label from both Body and Auth while preserving screen-reader labels, changed Add parameter/Add header hover text and border to white, added a compact response search field with focus-safe in-pane highlighting while typing, added a reliable response copy button with clipboard fallback handling, made the response scrollbar corner dark, and improved JSON response rendering to a Postman-like preformatted view. |
| Mobile response layout | The response metadata, search input, copy action, and Body form layout could crowd each other on narrow screens. | Added mobile-specific response-toolbar rules so the metadata and actions wrap cleanly, the response search is constrained to the available width, the Copy button remains usable, the fixed install button no longer overlaps the response action controls, and the Body select/key/value controls stack cleanly without horizontal overflow. |

## Validation Performed

The following checks were run against the final v18 package after removing the unintended blue closed-select treatment, keeping select borders and backgrounds aligned with the dark input palette, applying explicit dark native-menu support where browsers expose it, preserving the uniform `height: 40px` and `padding: 0 12px` control sizing, retaining the remove-row alignment, hidden-label, hover, and mobile response-toolbar improvements, and refreshing the service-worker cache namespace.

| Check | Result |
|---|---|
| Professional folder structure | Passed; root deployment files plus `assets/css`, `assets/js`, `assets/icons`, and `docs` are present. |
| `node --check assets/js/app.js` | Passed. |
| `node --check sw.js` | Passed. |
| Service-worker cache namespace | Passed; `CACHE_VERSION` is `restclient-shell-v13`. |
| Source review for dynamic HTML sinks and dynamic-code risks | Passed; no unsafe dynamic HTML rendering or dynamic-code execution constructs were found in executable app source files. |
| Browser Body/Auth label test | Passed; Body and Auth retain accessible screen-reader labels, and the visible label text is no longer `Type`. |
| Browser request-section control sizing test | Passed; Params, Headers, Auth, and Body dropdown/input controls computed to `height: 40px` with left/right `padding: 12px`, matching the requested `padding: 0 12px` rule. |
| Browser dropdown-border and menu-surface test | Passed; Body/Auth select borders and backgrounds match the surrounding input controls, the focused closed Auth select keeps the shared dark border/background with no box-shadow overlay, the request-method segmented border matches the shared border color, and dropdowns report a dark color scheme with dark option styling where Chromium exposes option computed styles. |
| Browser response search typing test | Passed; a real browser input operation preserved focus on `#response-search`, retained the full `userId` query, and created 100 safe in-pane highlights. |
| Browser focus-style test | Passed; the focused search control computed `outline-style: none` and `box-shadow: none`. |
| Browser response copy test | Passed; a real headless browser click changed the response copy button state to `Copied`. |
| Remove-row alignment and row-height test | Passed; generated key/value inputs and remove-row buttons computed to `40px`, and the remove-row button retained `padding-bottom: 2px` with border-box sizing to raise the `×` glyph slightly. |
| Add parameter hover test | Passed; real browser hover changed Add parameter text and border to `rgb(255, 255, 255)`. |
| Install button style and icon visibility test | Passed; computed button size was `45px` by `45px`, background was solid `rgb(31, 111, 202)`, border width was `0px`, and the icon remained `20px` by `20px` with white fill. |
| Response scrollbar corner test | Passed; the response pane scrollbar corner computed as a dark color rather than white. |
| Mobile response-toolbar layout test | Passed; at a 390px mobile viewport the response toolbar and actions wrapped, no horizontal overflow was detected, the search field and Copy button stayed within the toolbar, and neither response action overlapped the fixed install control. |
| Updated UI visual smoke test | Passed; desktop and mobile screenshots were captured as `ui-preview-v18-desktop.png` and `ui-preview-v18-mobile.png` in the working validation artifacts. |

The validation artifacts for this release are `../validation-v18-output.json`, `../validate-v18-ui.py`, `../ui-preview-v18-desktop.png`, and `../ui-preview-v18-mobile.png` in the working area used to produce the package. The release ZIP contains the application files and bundled documentation only.

## Files in the Improved Package

| Path | Purpose |
|---|---|
| `index.html` | Semantic application shell, CSP metadata, external asset references, response search/copy controls, accessible screen-reader-only Body/Auth select labels, and accessible icon-only PWA install button markup. |
| `assets/css/styles.css` | Restored dark GitHub-style UI styling, tighter tab layout, uniform 40px Params/Headers/Auth/Body input and dropdown controls with `padding: 0 12px`, input-matched dropdown borders/backgrounds, removal of the blue closed-select overlay, explicit dark color-scheme and dark option colors for supported native dropdown menus, remove-row `×` icon vertical alignment refinement, white Add parameter/Add header hover text and border, response-toolbar actions, mobile response-toolbar layout rules, dark response scrollbar corner styling, responsive layout, no-outline/no-shadow focus preference, offline-page styling, and 45px solid-blue icon-only install button presentation. |
| `assets/js/app.js` | Refactored application state, safe DOM rendering, request execution, PHP cURL generation, tab management, response rendering, response search/copy behavior, and PWA installation behavior. |
| `assets/icons/icon-192.png` | 192px application icon used by the manifest and browser chrome. |
| `assets/icons/icon-512.png` | 512px application icon used by the manifest and install surfaces. |
| `sw.js` | Conservative app-shell service worker with the refreshed v13 cache namespace and updated `/assets/...` cache allowlist. |
| `manifest.json` | PWA manifest metadata with updated icon paths. |
| `offline.html` | CSP-compliant offline fallback page with updated stylesheet and icon paths. |
| `CNAME` | Preserved custom-domain deployment configuration. |
| `docs/AUDIT_NOTES.md` | This handoff document. |

## Auditor Notes and Remaining Intentional Tradeoffs

The application is still a client-side REST client and therefore necessarily allows user-directed outbound connections. This is why the CSP uses a permissive `connect-src *`; tightening it to a fixed API allowlist would break the primary product function. Authentication values are deliberately not persisted, which improves security but means users must re-enter secrets after reload. This is an intentional security tradeoff suitable for audit-facing handling of credentials.

Because browser CORS policy applies to direct `fetch` calls, some endpoints that work through server-side cURL will still fail in the browser. The application reports this condition and continues to generate server-side PHP cURL code for those cases.
