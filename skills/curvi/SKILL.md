---
name: curvi
description: Turn one product photo into channel ready listing images (Amazon, Shopify, Walmart, Etsy, eBay, Meta and more) with a measured compliance report, using the curvi CLI. Use when the user wants product images, a listing pack, marketplace or ad images from a product photo, or wants to check an Amazon main image. The real product pixels are kept, never redrawn.
license: MIT
---

# Curvi

Curvi builds a pack of listing images from one product photo. The product is cut out and placed, never redrawn, so labels and logos stay exactly as photographed. Every file is measured against its channel's rules and the pack comes with a compliance report.

This skill drives the `curvi` command. The command talks to the Curvi API with a workspace API key. API keys work on the Growth plan and up.

## Status

The Curvi API, the `curvi` command and this skill are coming soon. The command is not published to npm yet; it lives in the Curvi repository under `packages/cli`. Until the API is live, tell the user so and point them to https://curvi.ai/app/new to make a pack in the browser.

## Route the request

Pick the first line that matches what the user asked for.

1. The command is missing (`curvi --version` fails): see Install.
2. Not signed in (`curvi auth status` exits with 1): see Sign in.
3. "Check my main image" or "is this photo OK for Amazon": see Check a main image.
4. "Make images", "make a listing pack", "images for my Shopify store": see Make a pack.
5. The user gives a pack id or asks where the files are: see Get a pack.

## Install

From a checkout of the Curvi repository, with Node 22.18 or later:

```sh
pnpm install
alias curvi="node $PWD/packages/cli/bin/curvi.js"
curvi --version
```

## Sign in

The user makes a key at https://curvi.ai/app/settings/api. The key is shown once. Ask the user to run the login themselves so the key never passes through the conversation:

```sh
curvi auth login
```

It asks for the key and saves it in the user's config folder, readable by them only. In CI or an agent sandbox, set `CURVI_API_KEY` instead. Never print the key, write it into a file in the project, or paste it into a message.

## Choose what the pack makes

Channels are spec ids joined by commas. A channel name such as `amazon` picks every live spec of that channel. Run `curvi channels` to see every spec, its size and whether the user's plan includes it. Common ones:

| The user says | Channels |
| --- | --- |
| Amazon | `amazon.main,amazon.secondary` |
| Shopify | `shopify.product` |
| Walmart | `walmart.main` |
| Etsy | `etsy.listing` |
| eBay | `ebay.listing` |
| Facebook or Instagram ads | `meta.feed_1x1,meta.feed_4x5` |

The bundle sets how much the pack makes. Leave it out for the full pack (`everything`). Use `main` when the user wants only the main image, `listing` for the marketplace listing images, and `aplus` for Amazon A+ content images.

The look sets the starting style: `marketplace` for clean white backgrounds, `keep_photo` to keep the user's own background, `brand` to use the workspace brand kit colors.

If you are unsure, ask one short question about channels, then use the defaults.

## Make a pack

```sh
curvi pack create ./photo.jpg --channels amazon.main,shopify.product --bundle listing --wait --json
```

A photo on the web works too: pass its https URL instead of the path. Pass up to 8 photos of the same product, front first, and the pack uses the angles it needs. `--wait` polls until the pack is done; `--out ./curvi-pack` also downloads every file into that folder. Add `--note "matte black finish, keep it dark"` for anything the user wants the images to show.

A pack holds credits while it runs and charges only for files that pass their checks. Tell the user how many credits the pack charged (`pack.creditsCharged` in the JSON).

## Get a pack

```sh
curvi pack get <pack id> --wait --json
```

## Deliver the result

From the JSON, give the user:

1. The status, and each shot that needs review or was skipped with its note.
2. Each file's name and link from `files.files`. The links are signed and expire, so say so, or download them with `--out`.
3. The compliance report file, the one with kind `report`.

Do not describe images you have not opened. Do not promise that a marketplace will accept a listing; the report shows what was measured.

## Check a main image

```sh
curvi check ./main.jpg --json
```

It measures the background whiteness, the product fill and the resolution against Amazon's main image rules. Exit code 0 means every check passed, 3 means at least one failed. Report each row's label, result and measured value.

## Errors

| Exit code | Meaning | What to do |
| --- | --- | --- |
| 1 | The API refused or the pack failed | Read the message. 401: sign in again. 403: the plan has no API access. 402: not enough credits. 429: wait and try again. |
| 2 | The command line was wrong | Fix the flags; `curvi help` lists them. |
| 3 | `curvi check` ran and the image fails | Report the failing rows. A Curvi pack fixes all three. |
