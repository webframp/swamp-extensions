// SPDX-License-Identifier: Apache-2.0

/**
 * Pinned upstream dependencies. Every file the extension downloads is listed
 * here with its SHA-256, and a download that does not match is rejected.
 *
 * To move to a new reveal.js release, change `REVEAL_VERSION` and regenerate
 * `REVEAL_FILES` from that release's npm tarball (see README.md).
 *
 * @module
 */

/** reveal.js release every deck is built against. */
export const REVEAL_VERSION = "6.0.1";

/** jsDelivr base URL for the pinned reveal.js release. */
export const REVEAL_CDN =
  `https://cdn.jsdelivr.net/npm/reveal.js@${REVEAL_VERSION}`;

/**
 * Base64 SHA-256 of every runtime file in the pinned release's `dist/`, keyed
 * by path relative to the package root. Checked against the npm tarball, whose
 * sha512 matches the registry's published integrity, and against jsDelivr's
 * file listing.
 */
export const REVEAL_FILES: Readonly<Record<string, string>> = {
  "dist/plugin/highlight.js": "pF76DCDcQajKSqn0teyX9Ow+5uZyk4o4XFA5IJgpGFk=",
  "dist/plugin/highlight/monokai.css":
    "UE5RMUFE8/gycVXcaVAroQsaSZGuTMP6cAhs8VVGWZk=",
  "dist/plugin/highlight/zenburn.css":
    "4pig8cLenepKziAs5+YMvDFD6/fqtC7+iRqIhfOSREw=",
  "dist/plugin/markdown.js": "c9vaPQxgBtF5QgPVQFEDqns+jz9Zrs88NZFBUNUTiM0=",
  "dist/plugin/math.js": "wZkEchA8BkCpshB38ysgNHp5YV9JWtNsLdVpjODsapI=",
  "dist/plugin/notes.js": "lGFZaAxwNUxmXb9PPJAjpzfYsUtIxsmvRSVTcXoEZyk=",
  "dist/plugin/search.js": "iHWRB5vruWWo0HMAsyMzntmNn0UEmHcTN5F08kgNLrA=",
  "dist/plugin/zoom.js": "PgB1DgmRypFDX+HH0LPvVJS7OYxAs9mUbdWmbEJgr3A=",
  "dist/reset.css": "OUE8NJD9z4JkJ8Jv9MHuWeqWGgqoUHwYRU4MbclsEtg=",
  "dist/reveal.css": "ZOYgPuIEhmXJ9Jw2jzRfs9f5NsQEk0FixwNpp2gvOI8=",
  "dist/reveal.js": "P7hMMNLmEN1ZiEPXWhI+8sTbxYiEfNqGzYx6YeGN22s=",
  "dist/theme/beige.css": "tGop+xjT4EUcJUXXKNtgkRwuhe5ndAdXqrtYKDLjp4A=",
  "dist/theme/black-contrast.css":
    "1EokGDX+do3LSHBZ68MhbUre70I8YhksdIS+xQv202s=",
  "dist/theme/black.css": "wpyWiejzsneqZu3AHtLvl5gaZ2iwWtdQWC6sBo2XBcM=",
  "dist/theme/blood.css": "FX6s6PFjVjg7izGh4f9cUHBxwPmQ7K/IWEHlhKOMr6s=",
  "dist/theme/dracula.css": "R7+GBcldYa0lwj0uFrfemsp5wcW18a8zVY+H8frvJtA=",
  "dist/theme/league.css": "IwPQs4tNc5kIESiU+T3couSjCtBYu4oYTIWwqd3ACgc=",
  "dist/theme/moon.css": "5a2v8Qg/GAFLCUUqrsUfpTn+q/tVQv/K4V6JPoPhZso=",
  "dist/theme/night.css": "j1gXbXLboyrW7N0tADXZNVdiaDt79xjduaQxy9TVg0g=",
  "dist/theme/serif.css": "m8GLLgIHFbdA32Vv0oyGIw6k6tqVyBmQHHvWSy0Yd4k=",
  "dist/theme/simple.css": "tsjfmhkcLyWs6/AHXXSBNHc/kWOFo1kwOlCaUoUVUcI=",
  "dist/theme/sky.css": "NDWnag05TJOGS5BjO1vlkO5dwPZDJVqMj+4CFPeZv/M=",
  "dist/theme/solarized.css": "kTAKOsBZ/gINs5EITR/H0P1Z+UiOQ0Ye8Bs9puvM4hw=",
  "dist/theme/white-contrast.css":
    "ztGVZD5XAMy7eSAzibargHQ0mpILVmzaCLRyKLTgpQU=",
  "dist/theme/white.css": "QelQfZfrE85oBGRanOnxYiDdw7/W54iKo6C19hd32PM=",
};

/** Built-in reveal.js themes, derived from `REVEAL_FILES`. */
export const REVEAL_THEMES: readonly string[] = Object.keys(REVEAL_FILES)
  .filter((p) => p.startsWith("dist/theme/"))
  .map((p) => p.slice("dist/theme/".length, -".css".length));

/** One pinned Emacs Lisp file, fetched by immutable commit. */
export interface ElispPin {
  file: string;
  version: string;
  url: string;
  /** Hex SHA-256. */
  sha256: string;
}

/**
 * Emacs Lisp the org-re-reveal engine loads. Org itself is the copy built into
 * Emacs. The URLs name commits rather than tags, so their content cannot move.
 */
export const ELISP_PINS: readonly ElispPin[] = [
  {
    file: "org-re-reveal.el",
    version: "3.39.0",
    url:
      "https://gitlab.com/oer/org-re-reveal/-/raw/85088676736b9884f7c330777560be3435bc53a7/org-re-reveal.el",
    sha256: "7673ddaf5b61efa95f1d54aa187a1051bca2432f55b86c93a88757cdd8e6cbce",
  },
  {
    file: "htmlize.el",
    version: "1.59",
    url:
      "https://raw.githubusercontent.com/emacsorphanage/htmlize/a24ed5a939a32c625b034b0b6d7f46340c100394/htmlize.el",
    sha256: "1ca98561ef4397f638f78c121a47670071cefe389333159bf91e2f9280289729",
  },
];
