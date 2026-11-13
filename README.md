# Fleet Web

A small browser UI for Fleet. Plain JavaScript and CSS, with a Node server for static files and an API proxy. No framework, bundler, CDN, or build step. The two runtime dependencies are `marked` and `dompurify`, for rendering and sanitizing Markdown.

The layout takes inspiration from [T3 Code](https://t3.codes/): a quiet sidebar, a focused conversation, and a persistent composer. It follows the device's light or dark appearance and uses a drawer on small screens.

## Run

Requires Node.js 22 or later and a running Fleet backend.

```sh
npm ci
npm start
```

Open **http://127.0.0.1:3000**. API requests are proxied to **http://127.0.0.1:1337**. The backend needs its normal provider configuration. Available roles and their parameters come from the backend.

To use different ports:

```sh
PORT=3001 FLEET_API_URL=http://127.0.0.1:1338 npm start
```

`HOST` defaults to `127.0.0.1`. Use `HOST=0.0.0.0` to make the UI reachable from another device on your network. The UI shows a sign-in page for the token set in the backend's `FLEET_ADMIN_TOKEN` and stores the session in an HttpOnly cookie. HTTPS is needed for installation, offline caching, and clipboard support when accessed through a non-localhost address.

## Sign-in

**Providers** in the sidebar shows each provider's connections. Fleet runs the OAuth exchange and stores the tokens; the browser only carries the provider's redirect back to Fleet.

When the UI is open at `http://127.0.0.1` and the provider accepts its port, the sign-in page redirects to this UI, which passes the result to Fleet and tries to close the window. This also works when Fleet runs on another machine and you reach the UI through an SSH tunnel, for example `ssh -L 3000:127.0.0.1:3000 server`. Otherwise Fleet listens at the provider's registered address itself, which only a browser on the Fleet machine can reach. In either case, if the sign-in page ends on an address that doesn't load, paste that address into the Providers dialog. Opening the UI as `localhost` instead of `127.0.0.1` uses Fleet's own listener or the paste form.

## Included

- Pinned, chats, working, snoozed, and settled sections. Settled agents load on demand.
- Pinned agents stay at the top of the sidebar while they work, in the order they were pinned. Pins are stored by Fleet. A snoozed pin returns to the top when it wakes. Settling an agent unpins it.
- Searchable roles and parameter controls generated from their schemas.
- A role view under **Roles** in the sidebar, also reached from the role name in the composer. It lists every role, including hidden ones. A role's page shows its model, tools, workspace, parameters, compaction and system prompt, and can start a new agent with that role.
- A role editor for creating and updating roles. Title, description, visibility and system prompt have their own fields. Model, tools, workspace, parameters and compaction are edited as JSON. Drafts are kept in the browser until saved or cancelled. If another client changes the role while you edit, your draft is kept and saving again replaces the current version.
- Messages sent while the agent works steer the current turn. Hold the send button, right-click it or press Alt Enter to queue for the next turn instead. Steering messages appear in the conversation right away. Queued messages stack as single lines above the composer until their turn starts. The send button becomes interrupt while work is running and the composer is empty.
- Live replies, resumable state updates, and older history loading.
- Markdown, code copying, and a trace toggle for reasoning, tool calls, results, and compaction.
- Scrolling that follows new content until a response fills the screen, then stops so it reads from the top. Large jumps glide, or stay put when the response start is already visible. Scrolling up stops following; returning to the end or using the latest button resumes it.
- A status menu in the header to pin or unpin an agent, and to settle, restore, or snooze an idle agent, with optimistic concurrency. While an agent works the menu only offers pinning.
- Server-backed titles with an edit button beside the conversation title.
- Local drafts, keyboard shortcuts, and mobile navigation.

New agents use the first message as their initial title. Use the pencil button to edit it, or clear the field to use the role and agent ID. Titles are stored by Fleet and synchronized across browsers. If another client changes the title while you edit, your draft is kept and the current title is shown for review before saving again. Unconfirmed edits retry with the same idempotency key and precondition.

Message drafts and an unconfirmed send are stored in this browser's local storage. Older browser-local title labels are no longer used or automatically uploaded. Agent data, titles, and confirmed messages remain on the Fleet backend.

Trace is a compact activity timeline. Each tool call has its own row, with its result attached when it arrives. Expand a row for arguments, output, copy controls, and the original raw events. Large outputs are excerpted until expanded further; copying always includes the full content. Reasoning starts collapsed, and turn boundaries and compaction use small markers. Open rows survive live updates and chat/trace toggles. Calls and results outside the loaded history remain visible and join up when earlier history is loaded.

Compaction shows “Compacting context…” in both chat and Trace, including while the next message
is still pending. This is a best-effort indication that an attempt started and may remain during
retry backoff; it is not a precise provider-request status. Completed compactions appear as
“Context compacted” markers in both views. The live indication requires a backend that publishes
`compacting` status on the existing preview subscription.

## Install

Use the browser's **Install app** or **Add to Home Screen** action. Browsers that expose an install prompt also show **Install Fleet** in the help dialog. The app opens in a standalone window, follows the device appearance, and leaves room for system controls around the screen edges.

The installed app restricts touch gestures to panning, without pinch or double-tap zoom. Normal browser tabs keep zoom available. Scroll areas keep overscroll feedback local instead of passing scrolling to their parents or triggering pull-to-refresh. Android's native edge stretch or bounce depends on the browser and its support for inner scroll areas; Fleet does not simulate it with JavaScript. Horizontal code blocks and tables still allow vertical scrolling through the conversation.

For a phone, serve the UI over HTTPS through a reverse proxy. A plain HTTP LAN address is not an installable origin. Localhost works for development.

The manifest includes regular, adaptive, and monochrome icons, plus a new-agent shortcut. Apple devices use a separate touch icon. Monochrome launcher theming depends on browser support. [Chrome's WebAPK format](https://chromium.googlesource.com/chromium/src/+/lkgr/components/webapk/webapk.proto) currently ignores monochrome icons.

Only the app shell is cached offline. API responses, credentials, model streams, and writes are never cached by the service worker. Local drafts remain available, but running agents requires a connection to Fleet.

The server versions the shell from its file contents, including the Markdown libraries. Open windows check for a new version when they become visible and every 30 minutes. A new version installs in the background, and **Update** appears beside the Fleet logo, with a dot on the sidebar button on small screens. Select it to reload with the new version, or close all Fleet windows to switch over. Other open windows show the button too, and nothing reloads on its own. Drafts and unconfirmed sends are kept, and updates do not replay writes.

## Structure

- `server.mjs`: static files and streaming API proxy.
- `public/api.js`: HTTP requests, idempotent writes, and reconnecting SSE.
- `public/state.js`: revision-aware resource merging and previews.
- `public/titles.js`: title selection and version-checked edits with safe retries.
- `public/render.js`: DOM rendering and sanitized Markdown.
- `public/trace.js`: activity rows derived from events, pending tools, and previews.
- `public/trace-render.js`: keyed trace rows and expandable inline details.
- `public/app.js`: navigation, subscriptions, and interactions.
- `public/scroll.js`: where a following conversation scrolls as content arrives.
- `public/sidebar.js`: the mobile drawer's drag and flick gesture.
- `public/roles.js`: the role picker and parameter controls for new agents.
- `public/role-view.js`: the role list, role pages and role editor form.
- `public/role-editor.js`: role editing state and conversion between the form and role definitions.
- `public/connections.js`: provider connections, API keys, and OAuth sign-in.
- `public/callback.js`: forwards OAuth redirects to Fleet. The server serves `callback.html` for any page address with `state` and `code` or `error` parameters.
- `public/pwa.js`: installation and service worker registration.
- `public/sw.js`: versioned app-shell caching. The server supplies its asset list and cache name.
- `public/icons/`: SVG sources and PNG launcher icons.

Theme colors, surfaces, shadows, and safe-area insets are defined in `public/styles.css`. Surfaces and dividers extend to the viewport edges; safe-area padding belongs to their content, not the page. The docked sidebar owns the left inset, while the main content uses it when the sidebar is a drawer. Dialogs fit inside the safe area, except the mobile role sheet, which extends to the edges and pads its contents. Matching light and dark browser colors are declared in `public/index.html`. The manifest uses charcoal for launch screens and system bars that do not follow the page theme. Installed Android apps may retain old manifest colors until Chrome updates their WebAPK, independently of the service worker update.

The collection subscription stays open. Selecting an agent adds a state subscription and a preview subscription, for a maximum of three. Navigation aborts the old subscriptions. Snapshots carry read revisions; updates older than those snapshots cannot restore stale resources. History pages merge by event cursor without losing newer edits. Preview text never enters the durable event cache.

Writes reuse their IDs and idempotency keys when retried. An uncertain send is retained across reloads so retrying cannot create a duplicate message.

The role view requires a backend with `GET /roles/{name}`. Editing requires `PUT /roles/{name}` with `Idempotency-Key`, and either `If-Match: "<version>"` to update or `If-None-Match: *` to create, as added in Fleet #5.

Title editing requires a backend with `title` and `metadata_version` on agent details and collection summaries. `PUT /agents/{id}/title` accepts `{"title":"New title"}` or `{"title":null}`, with `Idempotency-Key` and `If-Match: "<metadata_version>"`, and returns 204. This version is independent of the collection summary's `version` and the snapshot's `Read-Revision`; normal agent activity does not conflict with title edits. The UI chooses the newest title across the detail and collection streams using `metadata_version`.

## Images

Use the attachment button, paste an image, or drop images onto the composer. PNG, JPEG, GIF,
and WebP are supported, up to 10 MiB each, 20 images, and 40 MiB total per message. Uploads
run two at a time and resume from the server's accepted offset after interrupted requests.
Failed uploads have Retry and Remove controls; sending waits until every attachment is ready.
Image-only messages are supported.

Completed attachment references are saved with their draft, including across reloads. Unfinished
uploads retain their source file only while the page is open; after reloading, reattach the file.
No image bytes are written to localStorage or the service-worker cache. Incoming user and tool
images render in chat and expanded trace rows. The backend must implement the upload/blob
endpoints described in Fleet's README.

## Check

```sh
npm run check
npm test
```

`nix flake check` runs both and builds the package and container image.

Tests use Node's built-in test runner. They cover stream framing, revision merges, preview replacement, title conflicts and clearing, idempotent retries, and trace projection (tool/result pairing, partial history, async calls, provider tools, and streaming transitions). `npm run dev` restarts the server when its files change; close all Fleet tabs and app windows after the worker has downloaded an update, then reopen to use it. Chrome DevTools also offers **Update on reload** under Application → Service Workers for development.

## Package

`nix build .#image` builds a script that streams a container image, for example `./result | podman load`. The image serves on port 3000 of all interfaces; set `FLEET_API_URL` to the backend. CI publishes each commit on `main` as `ghcr.io/halo-org/fleet-web:<commit>` with the full commit hash.
